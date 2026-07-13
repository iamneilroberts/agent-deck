// Server-local types. The adapter *registry* key space is intentionally wider than the
// domain `AgentKind` (codex|claude): Phase 1 has no real Codex/Claude adapter, so both engine
// slots are backed by `FakeAdapter` instances, plus a third "fake" entry purely so
// `/api/health` and `/api/capabilities` can report a `fake` kind as shown in the contract's
// example response shape. Sessions themselves always persist `agentKind` as "codex" | "claude"
// (the shared `AgentKindSchema` allows nothing else) — see README "Contract deviations".
import type { AgentAdapter, AgentKind } from "@agentdeck/shared";
import type { EventStore } from "@agentdeck/event-store";
import type { GitService } from "./git/git-service.js";

export type AdapterRegistryKind = AgentKind | "fake";

export type AdapterRegistry = ReadonlyMap<AdapterRegistryKind, AgentAdapter>;

/** Everything `buildServer` needs, injectable so tests can supply an in-memory store/registry. */
export interface ServerDeps {
  store: EventStore;
  adapters: AdapterRegistry;
  /** Phase 1 single-user password. Never logged, never echoed in a response. */
  password: string;
  /** Read-only git access for the Phase 3 review routes. Default `new GitService()`; tests inject
   *  one backed by a fake `GitRunner` so no real repo is needed. */
  gitService?: GitService;
  /** Server version string surfaced on `/api/health`. */
  version?: string;
}
