import { describe, expect, it } from "vitest";
import { buildTestServer, loginCookieHeader, waitForEventType } from "./helpers.js";

/**
 * A live adapter session owns a child process (a real `codex`/`claude` for the real adapters).
 * When the server closes, those sessions must be stopped so the children don't outlive the
 * server process. The server registers a Fastify `onClose` hook that shuts down every adapter.
 */
describe("graceful shutdown", () => {
  it("stops live adapter sessions when the server closes", async () => {
    const { app, store } = await buildTestServer();
    const cookie = await loginCookieHeader(app);

    const projectRes = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: { cookie },
      payload: { name: "P", repositoryPath: "/tmp/agentdeck-test-repo" },
    });
    const project = projectRes.json();
    const sessionRes = await app.inject({
      method: "POST",
      url: "/api/sessions",
      headers: { cookie },
      payload: { projectId: project.id, agentKind: "claude", workingDirectory: "/tmp/agentdeck-test-repo" },
    });
    const session = sessionRes.json();

    // Park at a stable, live, non-terminal state (FakeAdapter PHASE_ONE ends here).
    await waitForEventType(store, session.id, "approval_requested");
    expect(store.getSession(session.id)?.status).toBe("waiting_for_approval");

    await app.close();

    expect(store.getSession(session.id)?.status).toBe("stopped");
  });
});
