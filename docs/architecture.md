# AgentDeck architecture

This is the working plan, reconciled against what the tools **actually** expose (verified
2026-07-13 against `codex-cli 0.144.1` and Node 22). Where the original brief guessed, this
document records the observed reality.

## 1. Goal & non-goals

Polished, mobile-first web control for local Codex and Claude Code sessions on one Linux host,
private over Tailscale. Emphasis: conversation, current activity, approvals, diffs, changed
files, tests, screenshots, session switching. A raw terminal is an escape hatch, not the
primary surface.

Out of scope for the MVP: re-implementing either agent, a code editor, public exposure,
multi-user SaaS, remote machines, Windows/macOS agents, syncing hidden context windows between
models, or running two agents against one working tree at once.

## 2. Core principle — separate project state from session state

Durable project state lives in Git and plain files both agents read:

```
AGENTS.md   CLAUDE.md
.agent/HANDOFF.md  .agent/CURRENT_TASK.md  .agent/DECISIONS.md  .agent/SESSION_LOG.md
```

A **handoff** is: stop/pause current agent → update handoff files → confirm tree → optional
WIP commit → start receiving agent → tell it to read the handoff and inspect Git. We never
translate a hidden context window between agents.

## 3. Component shape

```
Browser  ──HTTPS over Tailscale──▶  Caddy (bound to Tailscale iface)
                                         │
                                    AgentDeck server (bound to 127.0.0.1)
                                     ├─ auth / sessions      ├─ git service
                                     ├─ WebSocket event bus  ├─ artifact service
                                     ├─ event store (SQLite) ├─ approval service
                                     └─ agent adapter layer
                                          ├─ Codex adapter ─▶ codex app-server (stdio JSON)
                                          └─ Claude adapter ─▶ claude headless stream-json
                                                              (PTY fallback for TUI moments)
```

Stack: TypeScript, Node 22+, Fastify + `@fastify/websocket`, SQLite + Drizzle, Zod,
`node-pty`, `simple-git`, Pino. Frontend: React + Vite + TanStack Query + Zustand + Tailwind +
shadcn/ui, PWA, Monaco read-only only. Tests: Vitest, React Testing Library, Playwright, fake
agent adapters. No Kubernetes/Redis/Postgres/Electron in the MVP.

## 4. The neutral adapter boundary

The server and UI depend only on a vendor-neutral model. Vendor types stay inside adapter
packages. See ADR-0001.

```ts
type AgentKind = "codex" | "claude";
interface AgentAdapter {
  readonly kind: AgentKind;
  detectInstallation(): Promise<InstallationStatus>;
  startSession(i: StartSessionInput): Promise<SessionHandle>;
  resumeSession(i: ResumeSessionInput): Promise<SessionHandle>;
  sendMessage(sessionId: string, message: string): Promise<void>;
  approve(sessionId: string, requestId: string, decision: ApprovalDecision): Promise<void>;
  answerUserInput(sessionId: string, requestId: string, response: string): Promise<void>;
  interrupt(sessionId: string): Promise<void>;
  stop(sessionId: string): Promise<void>;
  subscribe(sessionId: string, l: (e: AgentEvent) => void): () => void;
  listRecoverableSessions(projectPath?: string): Promise<RecoverableSession[]>;
}
```

Normalized events carry `{ id, sessionId, sequence, timestamp, source }` and are persisted so
the browser can reconnect and replay. Raw terminal escape sequences are never the canonical
model.

## 5. Codex adapter — VERIFIED against the real protocol

`codex app-server` is the integration point (not TUI scraping). Confirmed facts:

- **Transport:** NDJSON over stdio (`--listen stdio://` default; also `unix://`, `ws://`).
  One JSON object per line; multiple objects can arrive in one chunk → line-buffered parser.
- **Envelope:** *not* JSON-RPC 2.0. Codex's own shape:
  - client→server request: `{ id, method, params }`
  - server→client response: `{ id, result }` or `{ id, error }`
  - notification (both directions): `{ method, params }` (no id)
  - server→client request (e.g. approvals): `{ id, method, params }`
- **Two independent ID spaces.** The server initiates its own requests starting at `id: 0`
  while the client uses its own counter. Route inbound messages by presence of `method`, not
  by id, and reply to a server request with *its* id.
- **Lifecycle (v2 `thread`/`turn` API):**
  1. `initialize` → `InitializeResponse` (`userAgent`, `codexHome`, `platformFamily/Os`).
  2. `initialized` notification (client→server).
  3. `thread/start` (`{ cwd, approvalPolicy, sandbox, model?, ... }`) → result carries the
     thread at `result.thread.id`, plus `model`, `runtimeWorkspaceRoots`, `instructionSources`,
     resolved `approvalPolicy`/`sandbox`. A `thread/started` notification follows. The
     app-server also boots the user's `~/.codex` MCP servers per thread
     (`mcpServer/startupStatus/updated` chatter).
  4. `turn/start` (`{ threadId, input: [{ type:"text", text, text_elements:[] }] }`) → stream
     of `turn/started`, `item/started`, `item/agentMessage/delta` (token deltas),
     `item/completed`, `thread/tokenUsage/updated`, `turn/completed` (`status:"completed"`).
  5. Interrupt: `turn/interrupt` (`{ threadId, turnId }`).
  6. Resume/history: `thread/list`, `thread/read`, `thread/resume` (`{ threadId }`).
- **Approvals (faithful pass-through):** when the sandbox blocks an action the server sends a
  request `item/commandExecution/requestApproval` (or `item/fileChange/requestApproval`,
  `item/tool/requestUserInput`, `item/permissions/requestApproval`). Its params include
  `availableDecisions` — the exact valid decisions for *this* prompt (e.g.
  `["accept", {acceptWithExecpolicyAmendment:{…}}, "cancel"]`). The client replies
  `{ id, result: { decision } }`; a `serverRequest/resolved` notification confirms. **The UI
  renders only the decisions the server offers — it never invents scopes.**
- **execpolicy auto-approves safe commands.** Under `read-only` sandbox + `on-request`, a
  trivially-safe `echo` runs with no approval request. Approval fires only when the action is
  actually blocked (e.g. a write under `read-only`) or under stricter policy. AgentDeck must
  not assume every command produces an approval.
- **Item types** (`ThreadItem`) map cleanly to timeline cards: `userMessage`, `agentMessage`
  (with `phase: commentary | final_answer`), `reasoning`, `commandExecution` (command, cwd,
  `processId`, `status`, `aggregatedOutput`, `exitCode`, `durationMs`), `fileChange`,
  `mcpToolCall`, `webSearch`, `plan`, etc.
- **Recovery:** thread IDs are UUIDv7, persisted on disk under `~/.codex/sessions/...jsonl`.
  After an AgentDeck restart, reconcile stored thread IDs via `thread/list` and re-attach with
  `thread/resume`.

Protocol types are machine-generated by the binary itself:
`codex app-server generate-ts --out <dir>` and `... generate-json-schema --out <dir>`. This
removes the reverse-engineering risk the brief anticipated — we build against generated types.

## 6. Claude adapter — corrected from the brief

The brief assumed PTY + hooks + fragile terminal parsing as the *primary* transport. That is
weaker than necessary. Claude Code exposes a headless, structured, streaming interface —
**verified by Spike B** (`spikes/claude-headless/`, `claude` v2.1.207, SDK 0.3.207):

- `@anthropic-ai/claude-agent-sdk` `query()` — structured messages (`system/init` with
  `session_id`, `assistant` text + `tool_use`, `user`/`tool_result`, `result` with cost/turns)
  over the `stream-json` control protocol. `--output-format` ∈ `text|json|stream-json`.
- `options.resume = <session_id>` recovers a session — context survived live. The SDK also
  ships `listSessions`/`getSessionInfo`/`forkSession`/`tagSession` for recovery UI.
- Programmatic approval is the SDK **`canUseTool(toolName, input)` callback** returning
  `{behavior:"allow"|"deny", updatedInput}` — it wraps the control-protocol `can_use_tool`
  message. **The `--permission-prompt-tool` flag the brief assumed is removed in v2.1.207.**
- Interrupt + streaming input are first-class (`query` handle `.interrupt()`; CLI advertises
  `capabilities:["interrupt_receipt_v1","msg_lifecycle_v1"]`).

**Decision:** the Claude adapter's primary transport is the Agent SDK, mirroring the Codex
adapter. `node-pty` is the *fallback* for genuinely interactive TUI moments, not the main path.
AgentDeck-managed sessions pass `settingSources: []` (or a dedicated `CLAUDE_CONFIG_DIR`) so the
operator's global hooks/CLAUDE.md don't bleed into a run, and the adapter filters
`system/hook_*` noise. The hooks bridge (`POST /internal/hooks/claude`,
`AGENTDECK_SESSION_ID`) is now *supplementary* lifecycle signal, not the source of truth.

## 7. Persistence, reliability, security

- **Process ownership:** the server owns agent child processes; a browser disconnect never
  kills an agent. Run under systemd. Reconcile Codex via `thread/resume`, Claude via
  `--resume`. Mark sessions interrupted if the AgentDeck server itself restarts.
- **Reliability:** monotonic per-session event sequence numbers; reconnect-from-last-sequence
  replay; WebSocket heartbeats; backpressure on high-volume output; SQLite WAL; idempotent
  approvals; duplicate-hook suppression. Unknown output is preserved as raw, never guessed.
- **Git safety:** one write session per working tree (enforced with a lock file *outside* the
  repo, `~/.local/share/agentdeck/locks/<project>.lock`); separate worktrees for parallelism;
  never auto reset/clean/force-checkout/rebase/delete.
- **Security:** localhost bind + Tailscale + Caddy; Tailscale identity or passkey/password auth
  with secure rotated cookies (no bearer-in-URL); project-root-scoped file browsing with an
  explicit external-path allowlist; `.env` shows existence/mtime/(opt-in) var *names* only,
  never values; configurable redaction for keys/tokens/cookies/DB URLs/passwords/private keys.
  Approvals are transmitted faithfully; any AgentDeck-side convenience approval is explicit,
  scoped, logged, revocable, and off by default.

## 8. Data model & API

SQLite (migrations): `projects`, `project_settings`, `agent_sessions`, `agent_events`,
`agent_processes`, `approval_requests`, `artifacts`, `handoffs`, `audit_log`, `user_sessions`.
Raw vendor events only in debug mode. Retention: normalized events 90d, raw terminal 14d, audit
180d, artifacts by-reference (paths + metadata, not copied).

REST for commands + initial state, WebSocket (`/api/events`) for live events. All payloads use
shared Zod schemas; state-changing requests carry idempotency keys where a double mobile
submit could harm.

## 9. Phases

- **Phase 0 — spikes** *(current)*: A) Codex app-server ✅ and A′) cross-process recovery +
  approval matrix ✅ (`spikes/codex-app-server/`); B) Claude headless via Agent SDK ✅
  (`spikes/claude-headless/` — streaming + canUseTool + resume verified);
  C) mobile streaming/reconnect ✅ (`spikes/mobile-streaming/` — WebSocket reconnect-from-
  last-sequence replay proven, no gaps/dups, localhost-only). **Phase 0 complete.**
  A′ established that one
  app-server multiplexing threads is the source-of-truth model (concurrent processes don't
  share a live turn), and that restart-recovery via `thread/resume` preserves context.
- **Phase 1 — foundation**: monorepo, shared types/schemas, SQLite migrations, project
  registration, session state machine, event store + replay, fake adapter, basic responsive
  UI, auth skeleton, systemd dev unit. *Done when a fake session runs independent of the
  browser and the phone UI reconnects and recovers all events with no real agent.*
- **Phase 2 — Codex MVP**: managed app-server process, transport, thread start/resume, turn
  messaging, streaming, command/tool events, approvals, interrupt, history, install checks.
- **Phase 3 — Git & file review**: status, changed-file list, unified diff, recent commits,
  safe file viewer, artifact detection, screenshots, Playwright reports, external allowlist.
- **Phase 4 — Claude MVP**: stream-json launcher + resume, hooks receiver/installer, event
  mapping, interactive-prompt handling, PTY fallback, slash-command controls.
- **Phase 5 — cross-agent handoff**: handoff file viewer, configurable slash commands, handoff
  + pickup workflows, worktree locks, dirty-state warnings, optional WIP commit, agent switch.
- **Phase 6 — hardening & install**: production auth, Caddy sample, Tailscale guide, systemd
  unit, log rotation, DB backup, upgrade, redacted diagnostic bundle, PWA install, security
  review + threat model.

## 10. MVP definition

Runs as a systemd service; opened from an iPhone over Tailscale; select a repo; start/resume a
Codex session; prompt + stream; approve/deny in the phone UI; inspect diffs and artifacts;
survive browser close and reconnect; run the repo handoff workflow; start/resume Claude and let
it read the shared handoff; raw terminal as fallback only; no `.env` values ever reach the
browser or logs.
