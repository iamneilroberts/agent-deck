# @agentdeck/server

The Fastify REST + WebSocket server: wires `@agentdeck/event-store`, the vendor-neutral
`@agentdeck/shared` contracts, and an adapter registry (Phase 1: `@agentdeck/fake-adapter`
only) together, and is what `apps/web` talks to. Implements
[`docs/api-contract.md`](../../docs/api-contract.md).

## Running

From the repo root, one command launches the server (watch mode) and the web UI together:

```
npm run dev
```

Or run the server alone:

```
npm run dev --workspace @agentdeck/server
```

Health check:

```
curl http://127.0.0.1:8080/api/health
```

## Env vars

| Var                  | Default                    | Notes                                                             |
| -------------------- | --------------------------- | ------------------------------------------------------------------ |
| `PORT`                | `8080`                       | Bind port.                                                          |
| `HOST`                | `127.0.0.1`                  | Bind host — **never** set this to `0.0.0.0`; see AGENTS.md.        |
| `AGENTDECK_PASSWORD`  | `agentdeck-dev`              | Phase 1 single-user login password. **Set this** outside a laptop-only setup — the default is logged as a warning on startup if unset. |
| `AGENTDECK_DB_PATH`   | `./agentdeck.sqlite3`        | SQLite file for `@agentdeck/event-store`. `:memory:` is used automatically by tests. |

The default dev password is **`agentdeck-dev`**.

## Architecture

- `src/server.ts` — `buildServer(deps: ServerDeps): Promise<FastifyInstance>`. Everything the
  server needs (the `EventStore`, the adapter registry, the password) is injected — no module
  reaches for a global — so tests build a fully wired server against an in-memory store.
- `src/main.ts` — process entry point; reads env, builds the default adapter registry, calls
  `buildServer` + `listen`.
- `src/lifecycle.ts` — the session lifecycle wiring: adapter events are persisted via
  `EventStore.appendEvent` (which assigns the real sequence) and only THEN broadcast to the WS
  hub. `session_status_changed` events route through `EventStore.updateSessionStatus` (which
  itself calls `assertTransition`); an illegal jump is logged and surfaced as a synthetic
  `error` event instead of corrupting the session's stored status.
- `src/hub.ts` — fan-out of stored events to connected WebSocket subscribers of a session.
- `src/ws/events-route.ts` — `GET /api/events`, the reconnect-and-replay protocol.
- `src/auth.ts` — the Phase 1 single-user cookie-session skeleton.
- `src/adapters/registry.ts` — the adapter registry (see "Adapter registry kinds" below).
- `src/routes/*.ts` — one file per REST resource group.

## Adapter registry kinds

Phase 1 has no real Codex/Claude adapter (Phase 2/4). Every engine slot is backed by
`FakeAdapter`: separate instances are registered under `"codex"` and `"claude"` (so a session
created with either `agentKind` gets its events correctly stamped with a matching `source`),
plus a third `"fake"` entry purely so `/api/health` and `/api/capabilities` can report a `fake`
key, matching the contract doc's example `adapters: {codex,claude,fake}` shape.

## Contract deviations (documented, not silent)

- **`PATCH /api/projects/:id` returns `501`.** `@agentdeck/event-store`'s `EventStore` exposes
  `createProject` / `getProject` / `listProjects` only — no update method. Rather than reach
  past the package's public API (which the task explicitly rules out), this route is treated
  like the other Phase-1-deferred routes until a project-update method ships in
  `@agentdeck/event-store`.
- **`AgentSession.externalSessionId` is not persisted after session creation.** The store has
  no generic session-update method beyond `updateSessionStatus`. The server tracks each
  session's vendor `externalSessionId` in memory (populated from the adapter's own
  `session_started` event) and uses it internally for `resume`; it just never lands in the
  persisted `AgentSession` row. A future `EventStore` update method should backfill this.
- **`GET /api/health`'s `adapters` field is a lightweight `Record<string, boolean>`** (is this
  kind registered?), not each adapter's full `detectInstallation()` result — that full detail
  (which the doc's "installed/auth status" language describes) is `/api/capabilities`'s job,
  kept separate so `/api/health` stays a fast, synchronous-ish liveness probe.
- **Idempotency-Key de-dup is in-memory, 10-minute TTL, not durable across restarts** — matches
  the contract's explicit "Phase 1: accept + de-dupe best-effort" note.

## Testing

```
npm run test --workspace @agentdeck/server
```

- `test/rest.test.ts` — auth gate, project/session CRUD, a full fake session run end-to-end
  (every scripted event lands in the store with contiguous sequences), an approval with an
  un-offered `optionId` rejected 400, a stopped session refusing to resume (409), Phase-3/5
  routes returning 501, and Idempotency-Key de-dup.
- `test/status-transition.test.ts` — a `ControllableAdapter` test double (no built-in
  transition check, unlike `FakeAdapter`) proves the **server's own** guard rejects an illegal
  `session_status_changed` jump and never corrupts the stored session status.
- `test/ws-reconnect.test.ts` — a real listening server + a real `ws` client proving the
  reconnect-and-replay guarantees: contiguous replay from `lastSeq+1`, the live tail resuming
  at `headSequence+1`, a disconnect-then-reconnect filling the gap with no missing/duplicate
  sequences, and `lastSeq` at/past head replaying nothing.
