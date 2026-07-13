# AgentDeck

**Self-hosted, phone-friendly control for local coding agents.**

AgentDeck runs on your Linux dev machine and gives you a mobile web interface to start, watch,
and steer local coding-agent sessions — [OpenAI Codex](https://developers.openai.com/codex) and
[Claude Code](https://docs.claude.com/en/docs/claude-code) — from your phone over
[Tailscale](https://tailscale.com/), without SSH and without any API key or `.env` ever leaving
the host.

Stream agent output in real time, answer approval and clarification prompts, review diffs and
changed files, watch test output and screenshots, and hand work between agents — all from a
browser that feels closer to a chat app than a terminal.

> ### Status: Phase 1 — working foundation
> The full end-to-end app runs today with a built-in **fake agent adapter**, so you can try the
> whole experience (sessions, streaming, approvals, reconnect-replay) with **no real agent and no
> API cost**. The real **Codex** and **Claude** adapters are Phase 2 / Phase 4 — their protocols
> are already validated end-to-end in [`spikes/`](spikes/). See the [Roadmap](#roadmap).

---

## Why

Coding agents run great on a workstation but you're not always at it. Existing options are an SSH
session on your phone (painful) or a vendor's hosted cloud (your code and keys leave your machine).
AgentDeck keeps **execution, source, and secrets entirely on your host** and puts a good mobile UI
in front of it, reachable privately over your tailnet.

**Design principle:** separate *project state* (Git + plain files both agents can read) from
*agent session state* (the model's hidden context). AgentDeck is a **faithful transport** over
each agent's own protocol — never a re-implementation, and **never a silent approver**: it shows
you exactly the approval choices the agent offered and passes your decision straight through.

---

## Features (Phase 1)

- **Mobile-first web UI** — sessions list, live activity timeline, prompt composer.
- **Real-time streaming** over WebSocket with **reconnect-and-replay**: drop your connection, walk
  through a tunnel, come back — no events missed or duplicated.
- **Faithful approvals** — the agent's own options are rendered as buttons; you can't approve a
  choice the agent didn't offer.
- **Persistent event log** (SQLite) — every session's history survives a browser refresh or a
  server restart.
- **Localhost-only by default** + cookie auth — designed to sit behind Tailscale.
- **Fake adapter** — a full scripted session for demos, development, and CI with zero API cost.

---

## Architecture

An npm-workspaces monorepo. The server and UI depend only on a **vendor-neutral core**; each
agent's specifics live behind a small adapter.

```
packages/
  shared        Vendor-neutral contracts: domain types, the normalized AgentEvent union,
                the approval model, the AgentAdapter interface, the session state machine.
                (Zod is the single source of truth; TS types are inferred from it.)
  event-store   SQLite (Drizzle + better-sqlite3): projects, sessions, and an append-only
                event log with monotonic per-session sequence numbers + gap-free replay.
  fake-adapter  A deterministic AgentAdapter that emits scripted sessions (no real agent).
apps/
  server        Fastify REST API + WebSocket event bus. Persists every adapter event, then
                broadcasts it; routes status changes through the state machine.
  web           React + Vite + Tailwind mobile UI. Reconnecting event client, timeline
                cards per event type, approval cards driven by the agent's offered options.
spikes/         Phase 0 protocol-validation harnesses (Codex app-server, Claude headless
                via the Agent SDK, mobile WebSocket reconnect) — proof the real adapters
                will work before they're built.
docs/           architecture.md, api-contract.md, adr/ (architecture decision records).
```

Key decision: [docs/adr/0001-adapter-architecture.md](docs/adr/0001-adapter-architecture.md).
Full design: [docs/architecture.md](docs/architecture.md). API: [docs/api-contract.md](docs/api-contract.md).

---

## Requirements

- **Linux** host (the target deployment; development works on any Unix-like OS).
- **Node.js 22+** and npm 10+.
- For the fake adapter and the full demo: nothing else.
- For real agents (later phases): the [`codex`](https://developers.openai.com/codex) and/or
  [`claude`](https://docs.claude.com/en/docs/claude-code) CLI installed and logged in.

---

## Quick start

```bash
git clone https://github.com/iamneilroberts/agent-deck.git
cd agent-deck
npm install
npm run dev
```

`npm run dev` starts both the API server (`http://127.0.0.1:8080`) and the web app
(`http://127.0.0.1:5173`) together. Open the web URL and log in with the default dev password:

```
agentdeck-dev
```

Then: **New session** → pick the demo project / working directory → watch the fake agent stream a
session, pause at an approval, and complete. Kill your browser tab mid-session and reopen it — the
timeline replays from where you left off.

> Set your own password with `AGENTDECK_PASSWORD`. The server refuses to expose anything beyond
> `127.0.0.1`; reach it from your phone by putting it on your [tailnet](#running-over-tailscale).

---

## Usage

- **Create a project** — point it at a local Git repository path.
- **Start a session** — choose the project and (later) the agent; send a prompt.
- **Watch the timeline** — assistant messages, commands + output, file changes, test results, and
  errors render as distinct cards. Noisy command output collapses by default.
- **Answer approvals** — when the agent needs permission, an approval card shows the command and
  the exact options the agent offered; tap one. It stays until you resolve it.
- **Reconnect anywhere** — the UI resumes the event stream from the last sequence it saw.

---

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8080` | Server port. |
| `HOST` | `127.0.0.1` | Bind address. **Do not** expose beyond localhost/Tailscale. |
| `AGENTDECK_PASSWORD` | `agentdeck-dev` | Login password (Phase 1 single-user auth). |
| `AGENTDECK_DB_PATH` | local file | SQLite database path (gitignored `*.sqlite3`). |
| `VITE_SERVER_ORIGIN` | `http://127.0.0.1:8080` | Where the web dev server proxies `/api`. |

Secrets are never sent to the browser or written to logs; token-shaped strings are redacted.

### Running over Tailscale

Put the host on your tailnet and reach AgentDeck at `http://<host>.<tailnet>.ts.net:5173` from your
phone. Keep the server bound to `127.0.0.1`; a reverse proxy bound to the Tailscale interface (e.g.
Caddy) is the intended production shape (Phase 6). **Never bind to `0.0.0.0` or expose to the public
internet** — this software runs shell commands as you.

---

## Development

```bash
npm install          # install all workspaces
npm run dev          # server + web together (hot reload)
npm test             # run every workspace's test suite (75 tests as of Phase 1)
npm run typecheck    # strict TypeScript across all workspaces
```

Per-workspace: `npm run test --workspace @agentdeck/server` (or `shared`, `event-store`,
`fake-adapter`, `web`). The `spikes/*` are standalone harnesses with their own READMEs.

Conventions: strict TypeScript (no `any`), Zod for external input, small tested pure functions,
adapters kept behind the neutral interface, and no destructive Git operations from the app. See
[AGENTS.md](AGENTS.md).

---

## Roadmap

- **Phase 0 — protocol spikes** ✅ Codex app-server, Claude headless (Agent SDK), mobile reconnect.
- **Phase 1 — foundation** ✅ *(you are here)* monorepo, neutral contracts, event store, fake
  adapter, server, mobile UI, auth skeleton.
- **Phase 2 — Codex adapter** wire the real `codex app-server`.
- **Phase 3 — Git & file review** diffs, changed files, artifacts/screenshots.
- **Phase 4 — Claude adapter** the real `claude` headless / Agent SDK.
- **Phase 5 — cross-agent handoff** hand work between Codex and Claude with a journaled handoff.
- **Phase 6 — hardening & install** production auth, Caddy/Tailscale guide, systemd, PWA.

---

## Contributing

Issues and PRs welcome. Please:

- Keep changes surgical and add tests with every behavioral change.
- Keep vendor specifics inside adapter packages, behind the neutral interface.
- Run `npm test` and `npm run typecheck` before opening a PR.
- Record notable architecture decisions as an ADR under `docs/adr/`.

---

## Security

AgentDeck controls a coding agent with shell and filesystem access — treat it as privileged. It
binds localhost only, keeps secrets off the wire and out of logs, and passes agent approvals
through faithfully. Do not expose it to the public internet. Report security issues privately to
the maintainer rather than opening a public issue.

---

## License

[MIT](LICENSE) © 2026 Neil Roberts.
