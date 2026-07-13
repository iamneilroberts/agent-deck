# AgentDeck

Self-hosted, phone-friendly control for local coding agents (Codex and Claude Code) running
on a Linux dev host, reached privately over Tailscale.

Start, resume, inspect, and steer agent sessions from a browser: stream output, answer
approval and clarification requests, review diffs and changed files, view test output and
screenshots, and hand work between agents — without SSH, and without any secret ever leaving
the host.

> **Status: Phase 0 (spikes).** No server or UI yet. The only thing built so far is
> [`spikes/codex-app-server`](spikes/codex-app-server/) — a validated, protocol-accurate
> harness that drives the real `codex app-server` end to end. See its README for what the
> protocol actually supports and what remains uncertain.

## Design in one paragraph

Separate **project state** (Git + plain files both agents can read) from **agent session
state** (the model's hidden context, which stays inside Codex/Claude). A handoff is not a
context transfer — it is: stop/pause the current agent, update the shared handoff files,
confirm the working tree, optionally WIP-commit, start the receiving agent, and tell it to
read the handoff and inspect Git. The app is a faithful transport over each agent's own
protocol, never a re-implementation and never a silent approver.

Full plan: [`docs/architecture.md`](docs/architecture.md) ·
adapter decision: [`docs/adr/0001-adapter-architecture.md`](docs/adr/0001-adapter-architecture.md).

## Layout (current)

```
docs/
  architecture.md              # the plan, adapted to what the Codex protocol actually is
  adr/0001-adapter-architecture.md
spikes/
  codex-app-server/            # Phase 0 Spike A — real protocol harness + tests
AGENTS.md                      # instructions for coding agents working in this repo
```

## Security posture (non-negotiable, even in spikes)

- Nothing binds beyond `127.0.0.1` / the Tailscale interface. The Phase 0 spike never opens
  a socket at all — it talks to `codex app-server` over stdio.
- No `.env` values, API keys, or auth tokens are transmitted to a browser or written to a
  committed log. Captured protocol transcripts are sanitized before they land on disk.
