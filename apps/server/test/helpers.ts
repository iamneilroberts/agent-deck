import { EventStore } from "@agentdeck/event-store";
import { FakeAdapter } from "@agentdeck/fake-adapter";
import type { AgentEventType } from "@agentdeck/shared";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import type { AdapterRegistry, ServerDeps } from "../src/types.js";

export const TEST_PASSWORD = "test-password";
export const SESSION_COOKIE_NAME = "agentdeck_session";

/** Tiny tick interval so scripted FakeAdapter events land near-instantly in tests. */
export function createTestRegistry(tickIntervalMs = 1): AdapterRegistry {
  const registry = new Map<"codex" | "claude" | "fake", FakeAdapter>();
  registry.set("claude", new FakeAdapter({ kind: "claude", tickIntervalMs }));
  registry.set("codex", new FakeAdapter({ kind: "codex", tickIntervalMs }));
  registry.set("fake", new FakeAdapter({ kind: "claude", tickIntervalMs }));
  return registry;
}

export interface TestServer {
  app: FastifyInstance;
  store: EventStore;
  adapters: AdapterRegistry;
}

export async function buildTestServer(overrides: Partial<ServerDeps> = {}): Promise<TestServer> {
  const store = overrides.store ?? new EventStore(":memory:");
  const adapters = overrides.adapters ?? createTestRegistry();
  const password = overrides.password ?? TEST_PASSWORD;
  const app = await buildServer({ store, adapters, password, version: "test" });
  return { app, store, adapters };
}

/** Logs in via `inject` and returns a `Cookie` header value for subsequent requests. */
export async function loginCookieHeader(app: FastifyInstance): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { password: TEST_PASSWORD },
  });
  const setCookie = res.headers["set-cookie"];
  const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  const match = raw ? /agentdeck_session=([^;]+)/.exec(raw) : null;
  if (!match) throw new Error(`login did not set a cookie (status ${res.statusCode})`);
  return `${SESSION_COOKIE_NAME}=${match[1]}`;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Polls `check` until it returns a truthy value or `timeoutMs` elapses. */
export async function waitFor<T>(
  check: () => T | undefined,
  { timeoutMs = 2000, intervalMs = 5 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error("waitFor timed out");
    await sleep(intervalMs);
  }
}

/**
 * Waits for a specific event *type* to land in the store, rather than polling session
 * `status`. `FakeAdapter`'s scripted steps emit one event per tick (docs: `tickIntervalMs`),
 * so a `session_status_changed` event and the very next scripted event (e.g.
 * `approval_requested`, which is what actually stops the script's timer) can land a tick apart
 * — polling on `status` alone can observe the status flip before that next event has been
 * persisted. Polling for the event itself is the precise synchronization point.
 */
export async function waitForEventType(
  store: EventStore,
  sessionId: string,
  type: AgentEventType,
  options?: { timeoutMs?: number; intervalMs?: number },
): Promise<void> {
  await waitFor(
    () => (store.getEventsSince(sessionId, 0).some((e) => e.type === type) ? true : undefined),
    options,
  );
}
