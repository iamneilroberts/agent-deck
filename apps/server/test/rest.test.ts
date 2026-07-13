import { describe, expect, it } from "vitest";
import { APPROVAL_REQUEST_ID, APPROVAL_OPTIONS } from "@agentdeck/fake-adapter";
import { buildTestServer, loginCookieHeader, waitFor, waitForEventType } from "./helpers.js";

async function createProjectAndSession(app: Awaited<ReturnType<typeof buildTestServer>>["app"], cookie: string) {
  const projectRes = await app.inject({
    method: "POST",
    url: "/api/projects",
    headers: { cookie },
    payload: { name: "Test project", repositoryPath: "/tmp/agentdeck-test-repo" },
  });
  expect(projectRes.statusCode).toBe(201);
  const project = projectRes.json();

  const sessionRes = await app.inject({
    method: "POST",
    url: "/api/sessions",
    headers: { cookie },
    payload: { projectId: project.id, agentKind: "claude", workingDirectory: "/tmp/agentdeck-test-repo" },
  });
  expect(sessionRes.statusCode).toBe(201);
  return { project, session: sessionRes.json() };
}

describe("auth gate", () => {
  it("returns 401 for a protected route without the session cookie", async () => {
    const { app } = await buildTestServer();
    const res = await app.inject({ method: "GET", url: "/api/projects" });
    expect(res.statusCode).toBe(401);
  });

  it("allows /api/health and /api/auth/login without a cookie", async () => {
    const { app } = await buildTestServer();
    const health = await app.inject({ method: "GET", url: "/api/health" });
    expect(health.statusCode).toBe(200);
    expect(health.json().adapters).toMatchObject({ codex: true, claude: true, fake: true });

    const badLogin = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { password: "wrong" },
    });
    expect(badLogin.statusCode).toBe(401);
  });

  it("logs in, sets a cookie, and grants access to protected routes", async () => {
    const { app } = await buildTestServer();
    const cookie = await loginCookieHeader(app);
    const res = await app.inject({ method: "GET", url: "/api/projects", headers: { cookie } });
    expect(res.statusCode).toBe(200);
  });

  it("logout revokes the cookie", async () => {
    const { app } = await buildTestServer();
    const cookie = await loginCookieHeader(app);
    const logout = await app.inject({ method: "POST", url: "/api/auth/logout", headers: { cookie } });
    expect(logout.statusCode).toBe(204);
    const after = await app.inject({ method: "GET", url: "/api/projects", headers: { cookie } });
    expect(after.statusCode).toBe(401);
  });
});

describe("projects + sessions", () => {
  it("creates a project and a session", async () => {
    const { app } = await buildTestServer();
    const cookie = await loginCookieHeader(app);
    const { project, session } = await createProjectAndSession(app, cookie);
    expect(project.name).toBe("Test project");
    expect(session.projectId).toBe(project.id);
    expect(session.status).toBe("starting");
  });

  it("PATCH /api/projects/:id is 501 (EventStore has no update method yet)", async () => {
    const { app } = await buildTestServer();
    const cookie = await loginCookieHeader(app);
    const { project } = await createProjectAndSession(app, cookie);
    const res = await app.inject({
      method: "PATCH",
      url: `/api/projects/${project.id}`,
      headers: { cookie },
      payload: { name: "renamed" },
    });
    expect(res.statusCode).toBe(501);
  });

  it("still-unbuilt session routes (Phase 5 /handoff) are 501, not 404", async () => {
    const { app } = await buildTestServer();
    const cookie = await loginCookieHeader(app);
    const { session } = await createProjectAndSession(app, cookie);
    // /diff, /files, /artifacts are implemented in Phase 3 (see git-review tests); /handoff remains.
    const res = await app.inject({ method: "GET", url: `/api/sessions/${session.id}/handoff`, headers: { cookie } });
    expect(res.statusCode).toBe(501);
  });
});

describe("full fake session lifecycle", () => {
  it("runs end to end and every scripted event lands in the store", async () => {
    const { app, store } = await buildTestServer();
    const cookie = await loginCookieHeader(app);
    const { session } = await createProjectAndSession(app, cookie);

    // PHASE_ONE pauses deterministically on approval_requested — no more events until approved.
    await waitForEventType(store, session.id, "approval_requested");

    const beforeApproval = store.getEventsSince(session.id, 0);
    expect(beforeApproval.map((e) => e.type)).toEqual([
      "session_started",
      "session_status_changed",
      "assistant_message",
      "assistant_message",
      "assistant_message",
      "command_started",
      "command_output",
      "command_output",
      "command_completed",
      "session_status_changed",
      "approval_requested",
    ]);
    // Sequences assigned by the store, contiguous from 1.
    expect(beforeApproval.map((e) => e.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);

    const approveRes = await app.inject({
      method: "POST",
      url: `/api/approvals/${APPROVAL_REQUEST_ID}/resolve`,
      headers: { cookie },
      payload: { sessionId: session.id, optionId: APPROVAL_OPTIONS[0]?.id },
    });
    expect(approveRes.statusCode).toBe(202);

    await waitFor(() => (store.getSession(session.id)?.status === "completed" ? true : undefined));

    const allEvents = store.getEventsSince(session.id, 0);
    expect(allEvents).toHaveLength(16);
    expect(allEvents.at(-1)?.type).toBe("session_status_changed");
    expect(allEvents.some((e) => e.type === "test_result")).toBe(true);

    const getRes = await app.inject({ method: "GET", url: `/api/sessions/${session.id}`, headers: { cookie } });
    expect(getRes.statusCode).toBe(200);
    const body = getRes.json();
    expect(body.session.status).toBe("completed");
    expect(body.headSequence).toBe(16);

    const eventsRes = await app.inject({
      method: "GET",
      url: `/api/sessions/${session.id}/events?since=11`,
      headers: { cookie },
    });
    expect(eventsRes.json().map((e: { sequence: number }) => e.sequence)).toEqual([12, 13, 14, 15, 16]);
  });

  it("rejects an approval optionId the agent never offered with 400", async () => {
    const { app, store } = await buildTestServer();
    const cookie = await loginCookieHeader(app);
    const { session } = await createProjectAndSession(app, cookie);
    await waitForEventType(store, session.id, "approval_requested");

    const res = await app.inject({
      method: "POST",
      url: `/api/approvals/${APPROVAL_REQUEST_ID}/resolve`,
      headers: { cookie },
      payload: { sessionId: session.id, optionId: "an-option-the-agent-never-offered" },
    });
    expect(res.statusCode).toBe(400);

    // Rejected decision must not have reached the adapter — session is still waiting.
    expect(store.getSession(session.id)?.status).toBe("waiting_for_approval");
  });

  it("a stopped session cannot be resumed (409)", async () => {
    const { app, store } = await buildTestServer();
    const cookie = await loginCookieHeader(app);
    const { session } = await createProjectAndSession(app, cookie);
    await waitForEventType(store, session.id, "approval_requested");

    const stopRes = await app.inject({ method: "POST", url: `/api/sessions/${session.id}/stop`, headers: { cookie } });
    expect(stopRes.statusCode).toBe(202);
    await waitFor(() => (store.getSession(session.id)?.status === "stopped" ? true : undefined));

    const resumeRes = await app.inject({ method: "POST", url: `/api/sessions/${session.id}/resume`, headers: { cookie } });
    expect(resumeRes.statusCode).toBe(409);
  });

  it("de-dupes a repeated Idempotency-Key on a state-changing POST", async () => {
    const { app, store } = await buildTestServer();
    const cookie = await loginCookieHeader(app);
    const { session } = await createProjectAndSession(app, cookie);
    await waitForEventType(store, session.id, "approval_requested");

    const idempotencyKey = "duplicate-submit-1";
    const first = await app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/interrupt`,
      headers: { cookie, "idempotency-key": idempotencyKey },
    });
    const second = await app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/interrupt`,
      headers: { cookie, "idempotency-key": idempotencyKey },
    });
    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(202);

    // Only one interrupt should have actually reached the adapter: one status_changed event
    // (waiting_for_approval -> paused), not two.
    const events = store.getEventsSince(session.id, 11);
    const pausedTransitions = events.filter(
      (e) => e.type === "session_status_changed" && e.status === "paused",
    );
    expect(pausedTransitions).toHaveLength(1);
  });
});
