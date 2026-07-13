# AgentDeck API contract (Phase 1)

The `apps/server` implementation target. REST for commands + initial state; WebSocket for the
live event stream. All payloads validate through `@agentdeck/shared` Zod schemas. Server binds
`127.0.0.1` only. Auth is a skeleton in Phase 1 (see below), hardened in Phase 6.

## REST

```
GET    /api/health                      -> { ok, version, node, adapters: {codex,claude,fake} }
GET    /api/capabilities                -> installed/auth status per adapter (detectInstallation)

GET    /api/projects                    -> Project[]
POST   /api/projects   {name,repositoryPath,defaultBranch?}  -> Project
GET    /api/projects/:id                -> Project
PATCH  /api/projects/:id                -> Project

GET    /api/sessions?projectId=&status= -> AgentSession[]
POST   /api/sessions   {projectId,agentKind,workingDirectory,prompt?,model?} -> AgentSession
GET    /api/sessions/:id                -> { session: AgentSession, headSequence: number }
POST   /api/sessions/:id/messages  {text}      -> 202
POST   /api/sessions/:id/interrupt             -> 202
POST   /api/sessions/:id/stop                  -> 202
POST   /api/sessions/:id/resume                -> AgentSession
GET    /api/sessions/:id/events?since=<seq>    -> AgentEvent[]   (replay via EventStore.getEventsSince)

POST   /api/approvals/:requestId/resolve  {sessionId, optionId, note?, updatedInput?} -> 202
POST   /api/input-requests/:requestId/respond {sessionId, response} -> 202
```

Phase 1 scope note: `/diff`, `/files`, `/artifacts` (Phase 3) and `/handoff` (Phase 5) are NOT
in Phase 1 — leave them unrouted or 501.

Every state-changing POST that a double mobile submit could duplicate accepts an optional
`Idempotency-Key` header (Phase 1: accept + de-dupe best-effort; full store later).

## WebSocket — `/api/events`

The live event bus. Reuses the reconnect-replay contract proven in `spikes/mobile-streaming`.

1. Client connects: `GET /api/events?sessionId=<id>&lastSeq=<n>` (or sends a `hello` message
   below after connecting).
2. Server messages (JSON, one per frame):
   - `{ "type": "hello_ok", "sessionId", "headSequence" }`
   - `{ "type": "event", "event": AgentEvent }` — replayed (seq > lastSeq) then live tail, in order
   - `{ "type": "replay_complete", "headSequence" }` — boundary between replay and live tail
   - `{ "type": "heartbeat", "ts" }` — app-level heartbeat (browser JS can't see ws ping frames)
   - `{ "type": "error", "message" }`
3. Client messages:
   - `{ "type": "hello", "sessionId", "lastSeq" }` — subscribe/resume from a sequence
   - `{ "type": "ping" }` (optional)

Guarantees (must hold, test them): replayed sequences are contiguous starting at `lastSeq+1`
with **no gaps and no duplicates**; the live tail resumes at `headSequence+1`; `lastSeq` ahead
of head replays nothing. The server persists every adapter event via `EventStore.appendEvent`
(which assigns the sequence) BEFORE broadcasting, so a reconnecting client always recovers the
full history.

## Session lifecycle wiring

- `POST /api/sessions` → `EventStore.createSession` (status `starting`) → `adapter.startSession`.
  Adapter events are appended to the store (sequence assigned) and broadcast to WS subscribers.
- Status changes route through `assertTransition` (illegal jump = 500 + logged, never a silent
  bad write). `session_status_changed` events are emitted by the server as `source:"agentdeck"`.
- `approve` / `answerUserInput` validate the decision against the pending `ApprovalRequest`
  (`isDecisionValidForRequest`) before calling the adapter — reject an invented option with 400.

## Auth skeleton (Phase 1)

- A single-user login: `POST /api/auth/login {password}` sets a secure, http-only, SameSite=strict
  session cookie (rotated on login); `POST /api/auth/logout` clears it. All `/api/*` except
  `/api/health` and the login route require the cookie. No bearer-token-in-URL.
- Phase 1 may store the password hash in an env var / config file (NOT in the events DB) and use
  an in-memory session table. Passkey/Tailscale-identity auth is Phase 6.

## Non-negotiables

- Bind `127.0.0.1` only. No `.env` values or secrets in any response or log. Redact tokens in
  logs. Unknown/unparseable adapter output is preserved as a raw event, never guessed.
