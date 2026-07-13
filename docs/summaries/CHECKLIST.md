# AgentDeck Checklist

## Checklist
- [x] Phase 0 — protocol spikes
- [x] Phase 1 — foundation (shared, event-store, fake-adapter, server, web)
- [x] Phase 2 — real Codex adapter (PR #1, merged)
- [x] Phase 3 — git & file review + web Review view (PR #2, merged)
- [ ] Phase 4 — real Claude adapter (Agent SDK; /handoff /pickup from UI; PTY fallback)
- [ ] Phase 5 — cross-agent handoff (fills /handoff 501 stub)
- [ ] Phase 6 — hardening & install (prod auth, Caddy/Tailscale, systemd, PWA, threat model)
- [ ] Cleanup: server shutdown hook to stop() adapter sessions (children leak on close)
- [ ] Cleanup: persist externalSessionId (resume only works within one server lifetime)
- [ ] Cleanup: Codex requestUserInput/permissions/mcp approvals; interrupt turnId race; real PATCH /projects
- [ ] Deferred P3: artifact byte-serving + detection + allowlist; recent-commits endpoint

_Updated: 2026-07-13 — main_
