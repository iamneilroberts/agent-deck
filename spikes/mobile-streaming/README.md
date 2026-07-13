# Spike C — mobile WebSocket streaming with reconnect-and-replay

**Phase 0 spike.** Proves the browser-reconnect story that AgentDeck's live event stream
depends on (`docs/architecture.md` §7 "reliability" and §9/§20 Phase 0 Spike C) — **before**
any real agent adapter exists. No agent, no API quota: the server generates fake
`AgentEvent`-shaped messages on a timer.

## Run it

```bash
cd spikes/mobile-streaming
npm install
npm run test        # the actual proof — real ws client against the real server, no browser
npm run typecheck
npm run spike        # starts the server on 127.0.0.1:8799; open http://127.0.0.1:8799/ in a browser
```

`npm run spike` also serves the phone-viewport page at `GET /` (same origin, same port) —
no separate static server needed. Everything else 404s except the WebSocket upgrade at `/ws`.

## What's here

- `src/events.ts` — the fake `AgentEvent` shape (`{ id, sessionId, sequence, timestamp, type,
  payload }`, mirroring the neutral event model in `docs/architecture.md` §4) and a
  deterministic payload generator that rotates through `agentMessage` / `commandExecution` /
  `fileChange` / `turnCompleted` so the fake stream reads like a real turn's item lifecycle.
- `src/store.ts` — `EventStore` (monotonic per-session sequence numbers, starting at 1) and
  `selectSince(events, lastSeq)`, the gap-replay logic as a pure function, unit-tested directly
  in `test/store.test.ts` with no server involved.
- `src/server.ts` — the WebSocket server. Binds **127.0.0.1 only** (verified with `ss` during
  manual testing — never `0.0.0.0`). Appends a fake event to the store on a timer and
  broadcasts it to every connected client. A client resumes from `lastSeq` two ways: `?lastSeq=
  <n>` on the connection URL, or an in-band `{"type":"hello","lastSeq":<n>}` message sent any
  time after connecting — both call the same `replayAndAttach`, which sends every event with
  `sequence > lastSeq` followed by a `{"type":"replayComplete","headSequence":<n>}` marker, then
  the connection is live. Heartbeats are two layers: a protocol-level `ws.ping()` (auto-answered
  by any compliant client, including the browser `WebSocket` API, for liveness/dead-connection
  cleanup) and an app-level `{"type":"heartbeat","timestamp":<n>}` message, because JS code
  never observes raw ping/pong frames — the app-level message is what the page and the tests
  actually watch for. `maxPayload` on the `WebSocketServer` guards against a runaway client
  message (`ws` terminates the connection if exceeded).
- `public/index.html` — a single self-contained vanilla-JS page (no build step, no CDN),
  mobile-first (390px-friendly, `viewport-fit=cover`). Shows connection state, a live event
  log, a manual Disconnect/Reconnect button, and auto-reconnects with exponential backoff
  (1s → 2s → 4s → … capped at 15s) using `?lastSeq=<last sequence rendered>` on each retry, so a
  phone that drops Tailscale for a few seconds and comes back sees the gap filled, not a
  truncated or duplicated log. This page is for manual/visual checking — it is **not** the
  proof of correctness.
- `test/reconnect.test.ts` — **the actual proof.** No browser. A real `ws` client against the
  real server on an ephemeral port: connect, receive live events, force-disconnect
  (`ws.terminate()`), let the server tick several more times while nobody is connected (the
  gap), reconnect with the last-seen sequence, and assert the replayed events are exactly
  contiguous (`lastSeq+1 … head`, no gaps, no duplicates) and that the live tail then resumes
  with no gap and no overlap. Also covers: `lastSeq` already ahead of the current head yields
  zero bogus replayed events; heartbeats arrive; the in-band `hello` resume path works
  independent of the query-string path; a malformed frame gets an `{"type":"error"}` reply and
  does not kill the connection.
- `test/store.test.ts` — unit tests for `selectSince`/`EventStore` in isolation (no sockets).

## Findings

- **The replay contract is trivial to get right with the right primitive.** `since(lastSeq)` is
  a single `filter(e => e.sequence > lastSeq)` over an append-only, monotonically-sequenced
  log. Because the log is never mutated, "lastSeq ahead of head" needs no special case — it
  just naturally returns `[]`. The hard part isn't the filter; it's making sure sequence
  assignment and the `replayComplete.headSequence` snapshot happen synchronously with the log
  read, so a concurrently-ticking timer can't sneak an event in between "what I replayed" and
  "what I claimed the head was" — Node's single-threaded event loop gives this for free as long
  as the replay loop and the `headSequence` read happen in the same synchronous call, which
  `replayAndAttach` does.
- **Two heartbeat layers are both necessary, for different reasons.** `ws.ping()` is what lets
  the *server* detect a half-dead TCP connection and terminate it (the standard
  ping/no-pong-within-interval pattern) — but browser JS never sees ping/pong frames, so it's
  invisible to the page and to a test written against `ws`'s `message` event. The app-level
  `heartbeat` message is what makes liveness observable to the client side at all.
  `docs/architecture.md` §7 says "WebSocket heartbeats" without specifying which layer; both
  turned out necessary once actually wiring the page.
- **Two resume paths (query string vs. in-band `hello`) share one code path cleanly.** Both
  just call `replayAndAttach(ws, lastSeq)`; the only difference is where `lastSeq` comes from.
  This matters for Phase 1: the query-string path lets the very first frame after connect be a
  replay (simplest for the page's auto-reconnect), but a future browser client that keeps a
  socket open across a flaky patch (rather than fully reconnecting) can ask for a replay
  in-band without tearing down the transport.
- **`maxPayload` on `WebSocketServer` is sufficient as a payload-size guard for this spike** —
  `ws` terminates the connection itself when exceeded; no per-message length-checking code was
  needed.

## What remains uncertain (for Phase 1)

- **Multi-session fan-out.** This spike uses one fake session and broadcasts to *every*
  connected client — fine for proving replay, but Phase 1's real event store needs per-session
  subscriptions (a client should only receive events for the session(s) it's viewing) and the
  URL needs a session identifier once there's more than one.
- **Persistence across a server restart.** The store here is purely in-memory; §8 calls for
  SQLite. Replay-from-lastSeq needs to survive the AgentDeck server process restarting, not
  just the browser reconnecting — that's a different failure mode this spike doesn't touch.
- **Backpressure under high-volume output.** §7 calls this out explicitly; a fast-produced
  event (e.g. streamed token deltas or large command output) hitting a slow mobile connection
  isn't exercised here — the fake generator produces one small event per tick, nothing like a
  bulk `aggregatedOutput` dump.
- **Real reconnect economics over Tailscale/cellular.** The page's backoff schedule (1s→15s
  cap) is a guess, not measured against real mobile network flakiness; Phase 1 should validate
  it against an actual phone losing and regaining a Tailscale link, not just a `ws.terminate()`
  in a unit test.
- **Auth on the WebSocket handshake.** This spike's `/ws` endpoint is unauthenticated by
  design (Phase 0, localhost-only, no real data). §7's passkey/password + rotated-cookie auth
  model needs to be threaded through the WebSocket upgrade request before this becomes a real
  endpoint, and that will change how `lastSeq` and session identity are established.
