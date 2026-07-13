// Proves the SERVER's own guard — not just the adapter's — rejects an illegal
// `session_status_changed` jump. Uses `ControllableAdapter`, which (unlike `FakeAdapter`) has
// no built-in transition check, so an illegal push here can only be caught by the lifecycle
// wiring routing through `EventStore.updateSessionStatus` (-> `assertTransition`).
import { describe, expect, it } from "vitest";
import { EventStore } from "@agentdeck/event-store";
import { ControllableAdapter } from "./controllable-adapter.js";
import { buildTestServer, loginCookieHeader, waitFor } from "./helpers.js";

describe("illegal session status transitions", () => {
  it("are rejected, logged, and never corrupt the stored session status", async () => {
    const store = new EventStore(":memory:");
    const controllable = new ControllableAdapter("claude");
    const adapters = new Map<"codex" | "claude" | "fake", ControllableAdapter>([
      ["claude", controllable],
      ["codex", controllable],
      ["fake", controllable],
    ]);
    const { app } = await buildTestServer({ store, adapters });
    const cookie = await loginCookieHeader(app);

    const projectRes = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: { cookie },
      payload: { name: "Transition test", repositoryPath: "/tmp/agentdeck-transition-test" },
    });
    const project = projectRes.json();

    const sessionRes = await app.inject({
      method: "POST",
      url: "/api/sessions",
      headers: { cookie },
      payload: { projectId: project.id, agentKind: "claude", workingDirectory: "/tmp/agentdeck-transition-test" },
    });
    const session = sessionRes.json();
    expect(session.status).toBe("starting");

    // "starting" can only legally go to running|failed|stopped — jumping straight to
    // "completed" is illegal per @agentdeck/shared's state machine.
    controllable.push(session.id, {
      type: "session_status_changed",
      source: "agentdeck",
      status: "completed",
      previous: "starting",
    });

    // The illegal transition must be surfaced as an error event rather than silently applied.
    const surfaced = await waitFor(() => {
      const events = store.getEventsSince(session.id, 0);
      return events.find((e) => e.type === "error") ?? undefined;
    });
    expect(surfaced.type).toBe("error");

    // The session's persisted status must be unchanged — never a silent bad write.
    expect(store.getSession(session.id)?.status).toBe("starting");

    // And the illegal event itself was never persisted as a session_status_changed(completed).
    const events = store.getEventsSince(session.id, 0);
    expect(events.some((e) => e.type === "session_status_changed" && e.status === "completed")).toBe(false);

    // A legal transition afterwards still works normally.
    controllable.push(session.id, {
      type: "session_status_changed",
      source: "agentdeck",
      status: "running",
      previous: "starting",
    });
    await waitFor(() => (store.getSession(session.id)?.status === "running" ? true : undefined));
    expect(store.getSession(session.id)?.status).toBe("running");
  });
});
