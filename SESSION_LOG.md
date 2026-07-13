## 2026-07-13 — AgentDeck Phase 0+1 built & shipped

Built AgentDeck from an empty directory to a working, live-verified open-source app: Phase 0
protocol spikes (Codex app-server, Claude Agent SDK, mobile WebSocket reconnect — all verified
against real binaries) and Phase 1 foundation (neutral `@agentdeck/shared` contracts + event-store
+ fake-adapter + Fastify server + React mobile UI). Verified end-to-end live (auth, streaming, a
faithful approval round-trip, reconnect-replay) with 75 tests green across 5 workspaces, then pushed
public. Opus held the correctness-critical work (spikes, contracts, all integration review, live
verification); Sonnet subagents did the mechanical package/UI/server builds. Phase 1 uses a fake
adapter — real Codex/Claude adapters are Phase 2/4.

Main artifact: https://github.com/iamneilroberts/agent-deck (branch main, HEAD bf022d7) ·
handoff: ~/.claude/coordination/agentdeck/handoffs/pause-2026-07-13-agentdeck-phase1-shipped.md
