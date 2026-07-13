# Spike B — Claude Code headless

**Phase 0 spike.** Validates the *Claude* side of ADR-0001 against the real `claude` CLI and
the official Agent SDK, the way Spike A validated Codex. Verified against **`claude` v2.1.207**
and **`@anthropic-ai/claude-agent-sdk` 0.3.207** on 2026-07-13.

> **Cost note:** unlike the Codex spikes (which spend ChatGPT/Codex quota), this spends the
> **Claude subscription / weekly limit**. It is pinned to `haiku` with tiny prompts, `maxTurns`
> capped, and two queries total (~$0.045 observed). Don't loop it.

## Run it

```bash
cd spikes/claude-headless
npm install
npm run typecheck
npm run spike        # drives real `claude` headless via the SDK (needs `claude` on PATH + logged in)
```

Writes a sanitized transcript to `captured/spikeb-<ts>.md`.

## Why the plan changed here

The original brief modeled Claude as **PTY + terminal scraping + hooks** as the *primary*
transport, in contrast to Codex's structured protocol. That is outdated. Claude Code has a
headless, structured, resumable interface — this spike proves it, so the Claude adapter can
mirror the Codex adapter instead of being a fragile parser (ADR-0001).

## What the spike demonstrates (against the real binary)

1. **Structured streaming.** `query()` yields typed SDK messages: `system/init` (carries
   `session_id`, `model`, `tools`, `capabilities`), `assistant` (text + `tool_use` blocks),
   `user` (`tool_result` blocks), and `result` (`subtype`, `num_turns`, `total_cost_usd`).
   This is the analogue of Codex's `thread`/`turn` stream.
2. **Programmatic approval via `canUseTool`.** The SDK invokes a `canUseTool(toolName, input)`
   callback for tools that need permission; the spike logs the tool + input and returns
   `{ behavior: "allow", updatedInput }` (or `{ behavior: "deny", message }`). Observed live:
   the `Bash` tool fired the callback, we allowed it, the command ran. This is faithful
   pass-through — the same discipline as Codex approval handling.
3. **Resume.** `options.resume = <session_id>` re-opens the same session; a follow-up query
   correctly recalled a value from the prior turn. Context survives — the recovery primitive.

Latest run: `captured/spikeb-*.md`.

## Findings that correct / sharpen ADR-0001

- **`--permission-prompt-tool` is GONE in v2.1.207.** The flag the brief/ADR referenced no
  longer exists. Permission is now the **control-protocol `can_use_tool`** message, surfaced by
  the SDK as the `canUseTool` callback (confirmed in the CLI bundle: `control_request` /
  `control_response` / `can_use_tool`, handler returns `behavior: allow|deny` + `updatedInput` /
  `updatedPermissions`). Use the SDK; don't hand-roll the wire framing or depend on the removed
  flag.
- **stream-json format values:** `--output-format` ∈ `text | json | stream-json`;
  `--input-format` ∈ `text | stream-json`. `--permission-mode` ∈
  `default | acceptEdits | auto | bypassPermissions | manual | dontAsk | plan`. Interrupt +
  streaming input are first-class (`--replay-user-messages`, `--include-partial-messages`;
  CLI advertises `capabilities: ["interrupt_receipt_v1","msg_lifecycle_v1"]`; the SDK `query`
  handle exposes `.interrupt()`).
- **The SDK ships session management** AgentDeck can lean on for recovery: `listSessions`,
  `getSessionInfo`, `getSessionMessages`, `forkSession`, `renameSession`, `tagSession`,
  `deleteSession`, plus `resume`. This is richer than Codex's thread APIs and maps cleanly to
  the neutral adapter's `resumeSession` / `listRecoverableSessions`.
- **Operator config bleeds into headless runs by default.** In a plain `claude -p` run the
  operator's global `SessionStart` hooks/skills/CLAUDE.md fired and were streamed as
  `system/subtype:"hook_*"` noise (and a `PreToolUse` hook could block a tool mid-turn). The
  SDK option **`settingSources: []`** isolates the run — AgentDeck-managed sessions should set
  this (or a dedicated `CLAUDE_CONFIG_DIR`) so the app controls the environment, and the
  adapter should filter `system/hook_*` messages regardless.
- **Auth:** `apiKeySource: "none"` — the CLI/SDK use the local subscription login, no API key
  needed. Cost is reported per `result` (`total_cost_usd`) — usable for AgentDeck's usage UI.

## What remains uncertain (for Phase 4)

- **Streaming multi-message input + mid-turn interrupt** captured only via the SDK handle's
  advertised `.interrupt()` and the `--input-format stream-json` flag — not yet exercised
  end-to-end here (single-prompt queries sufficed to prove the core). Exercise before Phase 4.
- **The `deny` path and `updatedInput` rewriting** (approve-with-edits) are typed but not run
  live — needed for the approval UI's non-happy paths.
- **Hooks bridge vs. SDK-only.** The brief's `POST /internal/hooks/claude` + `AGENTDECK_SESSION_ID`
  bridge is now *supplementary* (the SDK stream is the source of truth). Decide in Phase 4
  whether the hooks bridge is still worth wiring for lifecycle signals the SDK doesn't surface.
- **PTY fallback scope.** With the SDK covering the conversational surface, confirm the exact
  interactive-TUI moments (if any) that still need `node-pty`.

## Files

```
src/spike.ts   SDK-driven demonstration: streaming + canUseTool approval + resume
captured/      sanitized spikeb-*.md (committed)
```
