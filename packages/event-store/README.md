# @agentdeck/event-store

Persistence for AgentDeck's `Project`s, `AgentSession`s, and the normalized `AgentEvent`
stream, backing the reconnect-and-replay contract proven in `spikes/mobile-streaming`.

## SQLite driver

**Drizzle ORM on top of `better-sqlite3`**, as specified. `better-sqlite3`'s native build
succeeded cleanly on this box (`npm install` at the repo root compiles it; verified with a
standalone smoke test before writing any code), so there was no need to fall back to
`node:sqlite`.

Migrations are hand-written SQL (`src/migrations.ts`), applied in order and tracked in a
`schema_migrations` table, rather than `drizzle-kit`-generated files — this keeps the package
free of a codegen build step for three tables. `drizzle-orm`'s query builder is used for all
reads/writes in `src/store.ts`; raw SQL is only used for the migrations themselves and in one
test that reaches past the public API to prove the `UNIQUE(session_id, sequence)` constraint
is enforced by SQLite itself, not just application logic.

## Schema

- `projects` — mirrors `Project` (`packages/shared/src/domain.ts`).
- `agent_sessions` — mirrors `AgentSession`. Status changes route through
  `assertTransition` (`@agentdeck/shared`), so an illegal jump throws `InvalidTransitionError`
  instead of silently writing a bad status.
- `agent_events` — indexed base columns (`session_id`, `sequence`, `timestamp`, `source`,
  `type`) plus a `payload` JSON column holding the event's type-specific fields. A
  `UNIQUE(session_id, sequence)` constraint backstops the monotonic-sequence guarantee.

Every row read back is re-validated through the shared Zod schemas (`ProjectSchema`,
`AgentSessionSchema`, `AgentEventSchema`) before being returned, so a corrupt row throws
rather than silently mis-typing.

## `EventStore`

All methods are **synchronous** — `better-sqlite3` itself is synchronous, and `appendEvent`
relies on that: it reads the current max sequence for a session and inserts the new row
inside one `better-sqlite3` transaction with no `await` in between, so two calls can't
interleave and produce a duplicate or gapped sequence number even when driven concurrently
(e.g. via `Promise.all`). The `UNIQUE(session_id, sequence)` constraint is a hard backstop
behind that.

```ts
import { EventStore } from "@agentdeck/event-store";

const store = new EventStore(); // in-memory; pass a file path to persist
const project = store.createProject({ name: "agentdeck", repositoryPath: "/repo" });
const session = store.createSession({ projectId: project.id, agentKind: "claude", workingDirectory: "/repo" });

const event = store.appendEvent(session.id, { type: "session_started", source: "claude" });
// event.sequence === 1

const replay = store.getEventsSince(session.id, 0); // reconnect-replay query
store.close();
```

Pass `":memory:"` (the default) or an `os.tmpdir()` path for tests — no fixture files needed.

## Testing

```
npm run test --workspace @agentdeck/event-store
```

Covers: monotonic sequence starting at 1 (including independently per session); the
`getEventsSince` replay query filling gaps with no missing/duplicate sequences and returning
`[]` once `lastSeq` is at or past head; concurrent-style appends producing no duplicate or
gapped sequences; the `UNIQUE(session_id, sequence)` constraint; an illegal status transition
throwing `InvalidTransitionError`; and round-tripping one representative event of every
`AgentEvent` type through `appendEvent` → `getEventsSince`.
