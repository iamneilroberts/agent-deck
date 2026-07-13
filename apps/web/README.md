# @agentdeck/web

Mobile-first browser UI for AgentDeck: sessions list, session screen (conversation + activity
timeline), approval cards, and a login screen. Built to `docs/api-contract.md`.

## Dev

Needs `apps/server` running (the Fastify API this UI targets). Point Vite's dev proxy at it
with `VITE_SERVER_ORIGIN` (defaults to `http://127.0.0.1:8080`):

```bash
VITE_SERVER_ORIGIN=http://127.0.0.1:8080 npm run dev --workspace @agentdeck/web
```

This proxies `/api/*` (REST) and the `/api/events` WebSocket upgrade to the server, so the UI
runs against real data. Open `http://127.0.0.1:5173` (or whatever port Vite prints — bind to
Tailscale/localhost only, matching the server's `127.0.0.1`-only rule).

## Build / typecheck

```bash
npm run build --workspace @agentdeck/web       # tsc --noEmit, then vite build
npm run typecheck --workspace @agentdeck/web
```

## Test

```bash
npm run test --workspace @agentdeck/web
```

Vitest + React Testing Library, jsdom environment. **What's mocked:** `fetch` and `WebSocket`
are never hit for real — component tests drive the timeline and approval card off in-memory
`AgentEvent` fixtures (`test/fixtures/events.ts`) built to satisfy `AgentEventSchema`, and the
reconnect-replay logic (`src/ws/eventsClient.ts`) is tested against a hand-written fake socket
(`test/eventsClient.test.ts`) with fake timers driving the backoff — no real network or process
is started by the test suite.

## What's here

- `src/api/` — REST client (`credentials: "include"` for the cookie session) and TanStack Query
  hooks for server state (projects, sessions, mutations).
- `src/ws/` — the `/api/events` WebSocket client: `protocol.ts` (wire types, Zod-validated),
  `reducer.ts` (pure state transitions — replay/live/reconnect, sequence dedupe, backoff, all
  unit-testable without a socket), `eventsClient.ts` (the connecting class, injectable
  `WebSocket` factory), `useEventsClient.ts` (React binding).
- `src/store/uiStore.ts` — Zustand: which session is open, list filters, auth flag.
- `src/components/` — `SessionsList`/`SessionCard`/`NewSessionForm`, `SessionScreen`,
  `Composer`, `ApprovalCard`, `Login`, and `timeline/` (the per-event-type cards plus the pure
  `buildTimeline` fold that concatenates assistant/reasoning deltas by `itemId` and collapses
  `command_started`/`command_output`/`command_completed` by `commandId`).

## Known deviations from the contract doc

- Session-open always requests a full replay (`hello lastSeq: 0`) rather than resuming from a
  previously-seen sequence, since there is no persisted "last seen" across page loads yet.
  Mid-session drops correctly resume from the highest sequence actually rendered.
