import { FakeAdapter } from "@agentdeck/fake-adapter";
import type { AdapterRegistry } from "../types.js";

/**
 * Phase 1 has no real Codex/Claude adapter (those are Phase 2/4) — every engine slot is a
 * `FakeAdapter`. Two separate instances back "codex" and "claude" so a session created with
 * either `agentKind` gets events correctly stamped with a matching `source`; a third "fake"
 * entry is registered purely for `/api/health` + `/api/capabilities` reporting, matching the
 * documented `adapters: {codex,claude,fake}` shape.
 */
export function createDefaultAdapterRegistry(): AdapterRegistry {
  const registry = new Map<"codex" | "claude" | "fake", FakeAdapter>();
  registry.set("codex", new FakeAdapter({ kind: "codex" }));
  registry.set("claude", new FakeAdapter({ kind: "claude" }));
  registry.set("fake", new FakeAdapter({ kind: "claude" }));
  return registry;
}
