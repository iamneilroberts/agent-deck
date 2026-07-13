import { FakeAdapter } from "@agentdeck/fake-adapter";
import { CodexAdapter } from "@agentdeck/adapter-codex";
import type { AgentAdapter } from "@agentdeck/shared";
import type { AdapterRegistry, AdapterRegistryKind } from "../types.js";

/**
 * Phase 2: the "codex" slot is the REAL `CodexAdapter` (drives `codex app-server` over stdio) —
 * a session created with `agentKind: "codex"` spawns a real Codex process. "claude" remains a
 * `FakeAdapter` until Phase 4; a third "fake" entry is registered purely for `/api/health` +
 * `/api/capabilities` reporting, matching the documented `adapters: {codex,claude,fake}` shape.
 */
export function createDefaultAdapterRegistry(): AdapterRegistry {
  const registry = new Map<AdapterRegistryKind, AgentAdapter>();
  registry.set("codex", new CodexAdapter());
  registry.set("claude", new FakeAdapter({ kind: "claude" }));
  registry.set("fake", new FakeAdapter({ kind: "claude" }));
  return registry;
}
