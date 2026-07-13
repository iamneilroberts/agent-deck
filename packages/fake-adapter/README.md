# @agentdeck/fake-adapter

A deterministic `AgentAdapter` (`@agentdeck/shared`) with **no real agent process** behind it.
This is what lets a "fake session run independently of the browser" (Phase 1 definition of
done) and lets the server/UI be exercised end-to-end without a paid Codex/Claude API call.

## What it does

`FakeAdapter#startSession` plays a fixed scripted event stream out to `subscribe` listeners,
one event per tick:

`session_started` → `session_status_changed(running)` → three `assistant_message` deltas/final
→ `command_started`/`command_output`×2/`command_completed` → `session_status_changed
(waiting_for_approval)` → `approval_requested` (3 options: allow / allow-for-session / deny) →
**pauses** — nothing more is emitted until `approve()` is called with one of those option ids →
`session_status_changed(running)` → two more `assistant_message` deltas/final →
`test_result` → `session_status_changed(completed)`.

The full script (event shapes, not the runtime wiring) lives in `src/script.ts` as two step
arrays, `PHASE_ONE` (through the approval pause) and `PHASE_TWO` (after approval).

- `approve()` rejects (throws) any decision whose `optionId` wasn't among the offered options,
  via the shared `isDecisionValidForRequest`.
- `interrupt()` / `stop()` cancel the pending timer and, when the state machine allows it,
  emit a `session_status_changed` to `paused` / `stopped` — both are safe no-ops if the
  session already reached a state that can't make that jump.
- `sendMessage`, `answerUserInput`, `resumeSession`, `listRecoverableSessions` are all
  implemented with straightforward fake behavior (see doc comments in `src/fake-adapter.ts`).
  `answerUserInput` always rejects in the default script, since nothing in it ever raises a
  `user_input_requested` — it exists for interface completeness and for callers who inject
  their own pending request.
- Every `session_status_changed` step is checked against `canTransition`
  (`@agentdeck/shared`'s state machine) before being emitted — a bug in the script's own
  ordering fails loudly instead of quietly writing an illegal status.

## Determinism

No `Math.random()` and no wall-clock branching in the scripted *content* — the sequence of
event types and their text/fields is fixed, so tests can assert an exact stream. Timestamps
default to real time (allowed by spec) but are overridable, and `id` generation is overridable
too, via constructor options:

```ts
new FakeAdapter({
  tickIntervalMs: 1,           // default 5; small so streaming is observable but tests are fast
  idGenerator: () => "fixed",  // default crypto.randomUUID
  now: () => "2026-01-01T00:00:00.000Z", // default new Date().toISOString()
  kind: "codex",                // default "claude"
});
```

## Sequence numbers

Every emitted event carries `sequence: 0`. The adapter deliberately does not invent a
monotonic sequence — that's `EventStore.appendEvent`'s job (`@agentdeck/event-store`), which
owns the on-disk per-session counter. A server wiring this adapter to the store calls
`store.appendEvent(sessionId, event)` for each event the adapter emits; the store overwrites
`sequence` with the real next value.

## Testing

```
npm run test --workspace @agentdeck/fake-adapter
```

Covers: the ordered event types through the approval pause; that nothing more is emitted
until `approve()`; rejection of an un-offered `optionId` and of a mismatched `requestId`;
`interrupt`/`stop` ending the stream cleanly with no further events; every emitted event
validating against `AgentEventSchema`; and that two independent runs produce byte-identical
event shapes (aside from `id`/`sessionId`/`timestamp`), proving the script is deterministic.
