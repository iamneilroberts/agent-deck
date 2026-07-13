import { FakeAdapter } from "@agentdeck/fake-adapter";
import { CodexAdapter } from "@agentdeck/adapter-codex";
import { ClaudeAdapter } from "@agentdeck/adapter-claude";
import type { AgentAdapter } from "@agentdeck/shared";
import type { AdapterRegistry, AdapterRegistryKind } from "../types.js";

/**
 * Phase 4: the "codex" slot is the REAL `CodexAdapter` (drives `codex app-server` over stdio) and
 * the "claude" slot is the REAL `ClaudeAdapter` (drives `claude` headless via the Agent SDK) — a
 * session created with `agentKind: "codex"|"claude"` spawns a real agent. A third "fake" entry is
 * registered purely for `/api/health` + `/api/capabilities` reporting, matching the documented
 * `adapters: {codex,claude,fake}` shape.
 */
export function createDefaultAdapterRegistry(): AdapterRegistry {
  const registry = new Map<AdapterRegistryKind, AgentAdapter>();
  registry.set("codex", new CodexAdapter());
  registry.set("claude", new ClaudeAdapter());
  registry.set("fake", new FakeAdapter({ kind: "claude" }));
  return registry;
}
