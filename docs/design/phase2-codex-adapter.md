# Phase 2 Design — Real Codex Adapter (`@agentdeck/adapter-codex`)

**Status:** proposed, **reviewed** (adversarial design review folded in — see §11). **DoD:** drive a
real `codex` session from the phone.
**Grounded in:** `packages/shared/src/{adapter,events,approvals,domain,state-machine}.ts`,
`apps/server/src/lifecycle.ts`, and the live-verified spike `spikes/codex-app-server/src/*`.

> **Review verdict:** the spine (held-promise approval bridge, legal + fail-safe state-machine
> routing, event/sequence contract, 1:1 process model) is sound to build from. Three items **must**
> be resolved before §4/§5 are *locked* (not before the lift/pure-mapping work starts): (a) only
> `accept` is proven for `fileChange` — do not present unproven `decline`/`cancel` as "faithful"
> (§5.1); (b) `requestUserInput` **never fired** in any spike — treat as unproven/stub (§8);
> (c) add a transport **exit hook** so a mid-approval `codex` crash fails the held promises →
> `failed` (§8.5). All three are pinned by regenerating `codex app-server generate-ts` + adding
> decline/user-input steps to the live drive.

The adapter is a **faithful transport** (ADR-0001): it maps the Codex app-server protocol into
normalized `AgentEvent`s and passes approvals through verbatim — never inventing an option the
agent did not offer, never silently approving.

---

## 1. Package layout

```
packages/adapter-codex/
  package.json            # @agentdeck/adapter-codex, deps: @agentdeck/shared, zod
  src/
    index.ts              # export { CodexAdapter }
    codex-adapter.ts      # implements AgentAdapter — the one class the server programs against
    transport.ts          # lifted & generalized from spikes/.../transport.ts (CodexTransport)
    framing.ts            # lifted verbatim from spikes/.../framing.ts (LineBuffer, classify)
    proto.ts              # lifted from spikes/.../proto.ts — the wire subset we consume/produce
    session.ts            # CodexSession: one live thread (process + per-thread state)
    mapping.ts            # pure: Codex notification -> AgentEvent[]; availableDecisions -> options
    approvals-bridge.ts   # the deferred server-request <-> approval_requested/user_input bridge
    install.ts            # detectInstallation (probe `codex`)
  test/
    mapping.test.ts       # pure mapping table, fixture-driven (no process)
    approvals-bridge.test.ts
    codex-adapter.test.ts # fake transport injected — lifecycle without a real codex
```

`transport.ts` / `framing.ts` / `proto.ts` are **lifted from the spike** (already live-verified),
lightly generalized. `mapping.ts` and `approvals-bridge.ts` are **pure and unit-testable with no
process** — that is where the correctness risk concentrates, so that is where the tests concentrate.

**Registration** (Phase 2 wiring, `apps/server/src/adapters/registry.ts`): replace the
`registry.set("codex", new FakeAdapter(...))` line with `new CodexAdapter()`. Leave `claude` and
`fake` on `FakeAdapter` until Phase 4. No other server file changes (the `AgentAdapter` interface
is the whole contract — verified against `lifecycle.ts`).

---

## 2. Process model — one `codex app-server` per session (1 process : 1 thread)

**Decision:** spawn one `codex app-server` child per AgentDeck session; that process hosts exactly
one Codex thread. `stop()` = close the process.

Why, not the multiplex-one-process-many-threads alternative:
- The Spike A′ invariant is **"at most one live app-server per thread is the source of truth."**
  1:1 satisfies it trivially — there is never a second live view of a thread.
- Per-process isolation makes the `serverRequestHandler` (approvals) unambiguous: one transport,
  one thread, no threadId routing of server-initiated requests.
- `stop`/`interrupt`/crash blast radius is one session, not all of them.
- Cost is acceptable at phone-scale concurrency (a handful of sessions). Multiplexing is a later
  optimization, not a Phase 2 requirement.

> **Open question for review:** the handoff's decision line reads "one app-server *multiplexing
> threads* is the source-of-truth model." I read that as the *invariant* (one live view per
> thread), which 1:1 honors — not a mandate to share one process across threads. Confirm.

`CodexSession` owns: the `CodexTransport`, the `threadId` (= `externalSessionId`), the current
`turnId` (tracked from `turn/started`, needed for `interrupt`), the current `SessionStatus` mirror
(to emit *legal* transitions), and the pending-approval/user-input resolvers.

---

## 3. AgentAdapter method → Codex operation

| Method | Codex ops | Notes |
|---|---|---|
| `detectInstallation()` | spawn `codex --version` (fast path); optionally boot `app-server`+`initialize` for auth | returns `{installed, version, path, authenticated?}`; never throws |
| `startSession({sessionId, workingDirectory, prompt, model})` | spawn `app-server` → `initialize`+`initialized` → `thread/start {cwd, approvalPolicy:"on-request", sandbox, model}` → emit `session_started {externalSessionId=thread.id}` → `running`; if `prompt`, `turn/start` | subscribe already registered by lifecycle before this call |
| `resumeSession({externalSessionId, workingDirectory, prompt})` | spawn fresh `app-server` → `initialize` → `thread/resume {threadId}` → emit `session_started` → if `prompt`, `turn/start` | cross-process recovery proven in Spike A′ PART 2 |
| `sendMessage(sessionId, text)` | `turn/start {threadId, input: text}` | a new turn on the existing thread |
| `approve(sessionId, decision)` | resolve the held server-request with the mapped Codex decision (§5) | throws if no pending approval / bad optionId (defense in depth; server pre-validates) |
| `answerUserInput(sessionId, requestId, response)` | resolve the held `requestUserInput` server-request with `{answers}` (§5) | |
| `interrupt(sessionId)` | `turn/interrupt {threadId, turnId}` using tracked `turnId` | `turnId` is async (from `turn/started`); if `interrupt` races ahead of it, **await the next `turn/started`** (bounded) rather than silently no-op — else a just-started turn can't be stopped |
| `stop(sessionId)` | `transport.close()`; emit `stopped`; drop resolvers | terminal |
| `subscribe(sessionId, listener)` | register listener in a `Map<sessionId, Set<listener>>` independent of session runtime (mirrors FakeAdapter) | callable before `startSession` |
| `listRecoverableSessions(projectPath?)` | boot a short-lived `app-server` → `thread/list {cwd: projectPath}` → map to `RecoverableSession[]` | best-effort; may share one probe process |

**Event emission contract** (verified against `lifecycle.ts` + `AgentEventSchema`): the adapter
emits fully-formed events — `id` (uuid), `sessionId`, `sequence: 0`, `timestamp` (`new
Date().toISOString()`, whose `Z` suffix satisfies `datetime({offset:true})`) — and
`AgentEventSchema.parse`s each before handing it to listeners (fail loud on a mapping bug, exactly
as FakeAdapter does). The store assigns the real monotonic `sequence` (its `appendEvent` overrides
`sessionId`/`sequence`, keeps the adapter's `id`/`timestamp`). **`source` convention** (align with
FakeAdapter + `lifecycle.ts:164`): content events → `source: "codex"`; AgentDeck-originated
`session_status_changed` / synthetic `error` → `source: "agentdeck"`.

**Notification listener ordering** (no-loss requirement): register `transport.onNotification(...)`
**synchronously** after `transport.start()` and before the first `turn/start`, so the first async
notification can't slip past. `subscribe` (from `lifecycle`) is already registered before
`startSession`; this is the adapter-internal half of the same guarantee.

---

## 4. Codex notification → AgentEvent mapping

Pure function `mapNotification(n: WireServerNotification, ctx): AgentEvent[]` (0..n events). Table
below; **bold rows are live-proven in the spikes**, the rest are inferred from the generated
protocol types and MUST be reconciled against `codex app-server generate-ts` output before code.

| Codex notification | → AgentEvent | Notes |
|---|---|---|
| **`turn/started`** | track `turnId`; if status `starting`→`running` emit `session_status_changed` | completion is a notification, NOT the turn/start response (Spike A) |
| **`item/agentMessage/delta`** | `assistant_message {itemId, text:delta, phase:"delta"}` | |
| **`item/started` (agentMessage, final_answer)** | begin buffering final text (phase marker) | |
| `item/completed` (agentMessage) | `assistant_message {phase:"final", text}` | final form |
| `item/reasoning/delta` *(name TBV)* | `reasoning {itemId, text, phase:"delta"}` | reasoning stream — name not proven |
| `item/started`/`item/completed` (commandExecution) | `command_started` / `command_completed {exitCode,durationMs}` | |
| command output stream *(shape TBV)* | `command_output {commandId, chunk, stream}` | streaming stdout/stderr not captured in spike |
| `item/started`/`item/completed` (mcpToolCall) | `tool_started` / `tool_output` | |
| `item/completed` (fileChange) | `file_changed {path, changeType, diff?}` | applied edit (post-approval) |
| **`turn/completed`** | branch on `turn.status`: normal → `running`→`completed`; **`"interrupted"`** → `running`→`paused` | interrupted status is live-proven (`captured/aprime`); do NOT conflate with completion. Next turn re-enters `running` from either resting state |
| **`error`** (per thread) | `error {message, recoverable}` and/or `running`→`failed` | |

Two events can come from one notification (e.g. a status change **and** a content event) — hence
the `AgentEvent[]` return. `command_output` streaming shape and the reasoning/mcp item lifecycle
names are the **least-proven** part of this table and are called out in §8.

---

## 5. Approval bridge — the crux

Codex approvals arrive as **server-initiated requests** (`classify` → `serverRequest`: has both
`id` and `method`). The spike's transport answers them by **returning a value** from
`serverRequestHandler`, which `handleServerRequest` awaits and writes back as the response.

AgentDeck cannot answer synchronously — the phone must decide. The bridge exploits that the
transport already **awaits** the handler's returned promise:

```
serverRequestHandler(req):
  if req.method endsWith "/requestApproval":
      requestId = String(req.id)
      options   = mapAvailableDecisions(req.method, req.params.availableDecisions)  // §5.1
      emit approval_requested { request: { requestId, kind, summary, cwd, reason, details, options } }
      status running -> waiting_for_approval
      return new Promise(resolve => pendingApprovals.set(requestId, {resolve, method}))  // HELD OPEN
  if req.method == "item/tool/requestUserInput":
      requestId = String(req.id)
      emit user_input_requested { requestId, prompt, questions }
      status running -> waiting_for_user
      return new Promise(resolve => pendingUserInputs.set(requestId, {resolve, questions}))
  else: return decline-shaped default (never hang the turn)

approve(sessionId, decision):
  p = pendingApprovals.get(decision.requestId); if !p throw
  pendingApprovals.delete(...)
  status waiting_for_approval -> running
  p.resolve( decodeOption(p.method, decision.optionId, decision.note) )   // §5.2

answerUserInput(sessionId, requestId, response):
  p = pendingUserInputs.get(requestId); if !p throw
  pendingUserInputs.delete(...)
  status waiting_for_user -> running        # symmetric with approve() — else it sticks in waiting
  p.resolve({ answers: buildAnswers(p.questions, response) })
```

The `AgentAdapter` hands `answerUserInput` a single `response: string` (`adapter.ts:80`) but the
(inferred) Codex `answers` map is keyed per question id — **one string cannot distinctly answer
multiple questions.** Phase 2 limitation: assume a single-question input; document it. (This whole
path is unproven — see §8.)

Because the held promise is what `handleServerRequest` awaits, resolving it *is* sending the Codex
response on the wire. No change to the transport's request/response machinery is needed.

### 5.1 `availableDecisions` → `ApprovalOption[]` (faithful, no invention)
- Each entry in `availableDecisions` becomes exactly one `ApprovalOption`:
  - string decision (`"accept"`, `"acceptForSession"`, `"decline"`, `"cancel"`) →
    `id = the string`, `label` = friendly text, `kind` ∈ {allow, allow_always, deny, custom}.
  - object decision (`{acceptWithExecpolicyAmendment: {...}}`) → `id = JSON.stringify(decision)`
    (opaque, adapter-meaningful), `kind = "custom"`.
- **`fileChange` sends NO `availableDecisions`** — its decision set is a **generated protocol-fixed
  enum** `FileChangeApprovalDecision = "accept" | "acceptForSession" | "decline" | "cancel"` (see
  `codex-approval-matrix.md`). Surfacing this fixed set is **faithful** — it IS the protocol's
  contract for a request type that transmits no list — keyed on `method ===
  "item/fileChange/requestApproval"` with a source comment citing the generated enum. **Gate (a)
  CLOSED (step 0):** the enum was read from `codex app-server generate-ts` AND a live `decline` was
  captured — it round-tripped as `{decision:"decline"}`, the turn completed gracefully ("patch was
  rejected"), and the file was not written. So the "never invent" rule is honored: we offer only a
  real, read, live-proven protocol enum, never a guessed one.
- `options` is **never empty** (schema `.min(1)`); if a request type ever yields zero options the
  adapter declines the underlying request and emits an `error` rather than a malformed event.

### 5.2 `optionId` → Codex decision (round-trip)
`decodeOption(method, optionId, note)`: for a string `optionId` return the vendor response shape
the method expects (`{decision: optionId}` for command/file approvals — confirmed against
`spike-aprime.ts:45`). For a JSON-encoded `optionId`, `JSON.parse` it back and return `{decision:
parsedObject}` (the wrapper is still `{decision}`, the *value* is the amendment object — exact key
`acceptWithExecpolicyAmendment.execpolicy_amendment`, pinned by a round-trip fixture test). `note`
is attached where Codex accepts it. The mapping is **symmetric** with §5.1 and unit-tested both
directions on captured fixtures.

---

## 6. Status / state-machine routing

The adapter keeps a per-session `SessionStatus` mirror and only emits **legal** transitions
(`state-machine.ts`); `lifecycle.ts` independently re-checks via `assertTransition`, so a bug
surfaces as a synthetic `error`, never a corrupt status. Canonical path:

```
starting --(session_started, then turn/started)--> running
running  --(requestApproval)--> waiting_for_approval --(approve)--> running
running  --(requestUserInput)--> waiting_for_user --(answer)--> running
running  --(turn/completed)--> completed --(next turn/start)--> running
running  --(error)--> failed --(retry turn)--> running
any live --(stop())--> stopped   (terminal)
```

Guard: never emit `waiting_*` before `running` (state machine forbids `starting`→`waiting_*`). If a
turn/approval races ahead of the `running` emit, coalesce: emit `running` first.

---

## 7. Recovery & installation
- **`resumeSession`** spawns a fresh `app-server` and `thread/resume {threadId}` — proven to
  restore context across a **codex-process** restart (Spike A′ PART 2), i.e. within one
  AgentDeck-process lifetime (see §8.6 for the server-restart gap). It emits `session_started` with
  `externalSessionId` set (same as start). It does **not** re-attach to a still-live process (that
  would violate the source-of-truth invariant); the server only resumes sessions it believes are
  not live.
- **`detectInstallation`** shells `codex --version` for the fast path; `authenticated` is
  best-effort (left `undefined` if we cannot cheaply tell without a full boot). Never throws —
  returns `{installed:false, detail}` on ENOENT.

---

## 8. Least-confident areas (flag for the review + the live-drive)
1. **Item taxonomy names** — `item/reasoning/delta`, command output streaming, mcpToolCall
   lifecycle: the spike only exercised `agentMessage` + `commandExecution` + `fileChange`. The rest
   of §4 is inferred and MUST be reconciled against `codex app-server generate-ts` output before
   the mapping is trusted. Unknown item types → emit nothing (never guess) and log raw.
2. **Approval matrix — see `codex-approval-matrix.md` for the authoritative, generated types.**
   Proven live: `item/commandExecution/requestApproval` (accept) and `item/fileChange/requestApproval`
   (accept + **decline**, step 0). `requestUserInput`'s wire shapes are now **known** from generated
   types (`ToolRequestUserInputParams`/`Response`, `answers:{[qid]:{answers:string[]}}`) but it has
   **never fired live** and is experimental — implement against the real types behind a "verify
   live" flag, don't treat as a Phase-2 guarantee. `item/permissions/requestApproval` (complex
   `GrantedPermissionProfile` response) and `mcpServer/elicitation` remain unproven → **stub to a
   safe decline + `error`** until live-captured. NOTE the adapter uses the **v2** `item/*` methods,
   not the legacy v1 `execCommandApproval`/`applyPatchApproval` (different `ReviewDecision` enum).
3. **`sendMessage` while a turn is in flight** — Codex may reject a second `turn/start`. Decide:
   reject at the adapter, or queue. Proposal: reject with a clear error for Phase 2 (the UI already
   models a single active turn); revisit if the live drive shows queuing is needed.
4. **`initialize` capabilities** — the spike used `{experimentalApi:true, requestAttestation:false}`.
   Confirm these are the right production capabilities (esp. `experimentalApi`).
5. **Process-crash handling (was missing — now required).** `CodexTransport.failAll` rejects only
   *our* client→server `pending`; a **held approval promise** lives in the adapter's
   `pendingApprovals`, NOT in `pending`, so a `codex` crash mid-approval never settles it and the
   session orphans in `waiting_*`. The lifted transport must gain an **`onExit`/`onClose` hook**
   (its `onExit` currently only logs). On exit the adapter: rejects all held approval/user-input
   resolvers, emits `error {recoverable:true}`, and transitions the session → `failed`. Also guard
   `writeLine` against `this.closed` so a late resolve after crash doesn't write a dead pipe.
6. **Recovery scope.** Spike A′ PART 2 proved a **codex-process** restart while AgentDeck stays up —
   NOT an AgentDeck-server restart. `lifecycle` keeps `externalSessionId` in an in-memory `Map`
   only (never persisted to the store — no setter exists), so after a *server* restart `resume()`
   falls to `unknown-${sessionId}` and `thread/resume` rejects. Scope the recovery claim to "within
   one AgentDeck-process lifetime." Persisting `externalSessionId` is a **server-side** gap (out of
   adapter scope, a threaded cleanup) the fuller recovery story depends on. The adapter MUST emit
   `session_started` with `externalSessionId` set on **resume** too, not only start.

---

## 9. Testing strategy (TDD, no paid calls in unit tests)
- **`mapping.test.ts`** — fixture-driven: real captured notification JSON (from
  `spikes/.../captured/`) → asserted `AgentEvent[]`. The correctness core.
- **`approvals-bridge.test.ts`** — availableDecisions → options → decision round-trip, incl. the
  fileChange fixed-enum case and the object-decision JSON round-trip.
- **`codex-adapter.test.ts`** — inject a **fake transport** (same interface as `CodexTransport`) to
  drive the full lifecycle (start → deltas → approval held → approve → complete → reconnect) with
  zero real process, asserting the emitted event sequence and legal status transitions.
- **Live drive (Opus, manual, gated):** against real `codex` — start a session from a fixture repo,
  stream a turn, trigger a command approval, approve from the decision set, confirm the file/edit,
  resume after a simulated restart. This is the DoD gate, not a CI test.

---

## 10. Build sequence
0. **DONE ✅** — regenerated `codex app-server generate-ts --experimental` and live-captured a
   fileChange `decline`. Authoritative matrix recorded in `codex-approval-matrix.md`; §11 gate items
   (a)/(b) closed. Next runs start at step 1.
1. Lift `transport.ts`/`framing.ts`/`proto.ts` into the package; **add the `onExit` hook + fake-
   transport seam** (§8.5).
2. `mapping.ts` + tests (pure, fixture-driven).
3. `approvals-bridge.ts` + tests (incl. object-decision round-trip, crash → reject-held).
4. `codex-adapter.ts` assembling the above against `AgentAdapter`; adapter test with fake transport.
5. Register in the server; `npm test` green across workspaces.
6. Opus live-drive against real `codex` (DoD) — incl. an actual command approval, a fileChange
   **decline**, an interrupt, and a resume.

Pattern (per handoff): **Opus locks §4/§5/§6** (the mapping + approval + status core), **Sonnet
does the mechanical lift/wiring/tests**, **Opus does the live drive**.

---

## 11. Review outcome + gate status
Adversarial design review (Opus) confirmed the spine is sound. Gate status after build **step 0**
(regen `generate-ts` + live captures — see `codex-approval-matrix.md`):
- **(a) CLOSED ✅** `fileChange`: generated `FileChangeApprovalDecision` enum read (`accept /
  acceptForSession / decline / cancel`); `decline` live-captured (round-tripped, turn graceful, file
  not written). The fixed set is faithful, cited to the generated enum (§5.1).
- **(b) CLOSED (downgraded, not eliminated) ⚠️** `requestUserInput` wire shapes are now known from
  generated types (no longer guesses), BUT it never fired live and is experimental → implement
  behind a "verify live" flag; `permissions`/`mcpToolCall`/elicitation stay stub-decline (§8.2).
- **(c) OPEN → implementation task 🔧** transport `onExit` hook: on crash reject held approval/user-
  input promises, emit `error`, transition → `failed`; guard `writeLine` on `closed` (§8.5). Not a
  research gate — done during the transport lift (step 1).

Folded-in fixes already reflected above: interrupted `turn/completed` → `paused` not `completed`
(§4); `answerUserInput` status symmetry + single-question limit (§5); object-decision `{decision:
obj}` wrapper (§5.2); interrupt null-`turnId` race (§3 table); `source` convention (§3); recovery
scoped to one AgentDeck-process lifetime + `externalSessionId` server-persist gap (§7/§8.6).
None of these block starting step 0/1; all three gate items must close before §4/§5 are locked.
