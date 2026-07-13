import { EventStore } from "@agentdeck/event-store";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/server.js";
import { GitService, type GitRunResult, type GitRunner } from "../src/git/git-service.js";
import { createTestRegistry, loginCookieHeader, TEST_PASSWORD } from "./helpers.js";

interface FakeRunnerOptions {
  isRepo?: boolean;
  hasHead?: boolean;
  branch?: string;
  head?: string;
  statusOutput?: string;
  diffOutput?: string;
}

/** Builds a fake GitRunner that returns canned output per git subcommand, and records every
 *  invocation's args so tests can assert what (if anything) was actually "shelled out to". */
function makeFakeRunner(opts: FakeRunnerOptions = {}): { runner: GitRunner; calls: string[][] } {
  const { isRepo = true, hasHead = true, branch = "main", head = "deadbeef", statusOutput = "", diffOutput = "" } = opts;
  const calls: string[][] = [];
  const runner: GitRunner = async (args): Promise<GitRunResult> => {
    calls.push(args);
    const [cmd, sub] = args;
    if (cmd === "rev-parse" && sub === "--is-inside-work-tree") {
      return isRepo
        ? { stdout: "true\n", stderr: "", code: 0 }
        : { stdout: "", stderr: "fatal: not a git repository\n", code: 128 };
    }
    if (cmd === "rev-parse" && sub === "--abbrev-ref") return { stdout: `${branch}\n`, stderr: "", code: 0 };
    if (cmd === "rev-parse" && sub === "HEAD") return { stdout: `${head}\n`, stderr: "", code: 0 };
    if (cmd === "rev-parse" && sub === "--verify") {
      return hasHead ? { stdout: `${head}\n`, stderr: "", code: 0 } : { stdout: "", stderr: "", code: 128 };
    }
    if (cmd === "status") return { stdout: statusOutput, stderr: "", code: 0 };
    if (cmd === "diff") return { stdout: diffOutput, stderr: "", code: 0 };
    return { stdout: "", stderr: "", code: 0 };
  };
  return { runner, calls };
}

async function buildServerWithGit(runner: GitRunner): Promise<FastifyInstance> {
  const store = new EventStore(":memory:");
  const adapters = createTestRegistry();
  return buildServer({
    store,
    adapters,
    password: TEST_PASSWORD,
    version: "test",
    gitService: new GitService(runner),
  });
}

async function createProjectAndSession(app: FastifyInstance, cookie: string) {
  const projectRes = await app.inject({
    method: "POST",
    url: "/api/projects",
    headers: { cookie },
    payload: { name: "Test project", repositoryPath: "/tmp/agentdeck-git-review-test" },
  });
  expect(projectRes.statusCode).toBe(201);
  const project = projectRes.json();

  const sessionRes = await app.inject({
    method: "POST",
    url: "/api/sessions",
    headers: { cookie },
    payload: {
      projectId: project.id,
      agentKind: "claude",
      workingDirectory: "/tmp/agentdeck-git-review-test",
    },
  });
  expect(sessionRes.statusCode).toBe(201);
  return { project, session: sessionRes.json() };
}

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("GET /api/sessions/:id/files", () => {
  it("returns the parsed status for a repo", async () => {
    const { runner } = makeFakeRunner({ statusOutput: " M tracked.txt\0?? new-file.txt\0" });
    app = await buildServerWithGit(runner);
    const cookie = await loginCookieHeader(app);
    const { session } = await createProjectAndSession(app, cookie);

    const res = await app.inject({ method: "GET", url: `/api/sessions/${session.id}/files`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.workingDirectory).toBe("/tmp/agentdeck-git-review-test");
    expect(body.isGitRepo).toBe(true);
    expect(body.branch).toBe("main");
    expect(body.head).toBe("deadbeef");
    expect(body.files).toEqual([
      { path: "tracked.txt", status: "modified", staged: false, untracked: false },
      { path: "new-file.txt", status: "untracked", staged: false, untracked: true },
    ]);
  });

  it("reports isGitRepo:false when the working directory is not a repo", async () => {
    const { runner } = makeFakeRunner({ isRepo: false });
    app = await buildServerWithGit(runner);
    const cookie = await loginCookieHeader(app);
    const { session } = await createProjectAndSession(app, cookie);

    const res = await app.inject({ method: "GET", url: `/api/sessions/${session.id}/files`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ isGitRepo: false, branch: null, head: null, files: [] });
  });

  it("404s for an unknown session id", async () => {
    const { runner } = makeFakeRunner();
    app = await buildServerWithGit(runner);
    const cookie = await loginCookieHeader(app);
    const res = await app.inject({
      method: "GET",
      url: "/api/sessions/00000000-0000-0000-0000-000000000000/files",
      headers: { cookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it("401s without the session cookie", async () => {
    const { runner } = makeFakeRunner();
    app = await buildServerWithGit(runner);
    const res = await app.inject({ method: "GET", url: "/api/sessions/anything/files" });
    expect(res.statusCode).toBe(401);
  });
});

describe("GET /api/sessions/:id/diff", () => {
  it("returns the fake diff string for the whole repo", async () => {
    const { runner } = makeFakeRunner({ diffOutput: "--- a/tracked.txt\n+++ b/tracked.txt\n@@ -1 +1 @@\n-old\n+new\n" });
    app = await buildServerWithGit(runner);
    const cookie = await loginCookieHeader(app);
    const { session } = await createProjectAndSession(app, cookie);

    const res = await app.inject({ method: "GET", url: `/api/sessions/${session.id}/diff`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.isGitRepo).toBe(true);
    expect(body.diff).toContain("tracked.txt");
    expect(body.path).toBeUndefined();
  });

  it("scopes the diff to a single path and passes it to git after --", async () => {
    const { runner, calls } = makeFakeRunner({ diffOutput: "diff for one file\n" });
    app = await buildServerWithGit(runner);
    const cookie = await loginCookieHeader(app);
    const { session } = await createProjectAndSession(app, cookie);

    const res = await app.inject({
      method: "GET",
      url: `/api/sessions/${session.id}/diff?path=src/x.ts`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.path).toBe("src/x.ts");
    expect(body.diff).toBe("diff for one file\n");

    const diffCall = calls.find((c) => c[0] === "diff");
    expect(diffCall).toEqual(["diff", "HEAD", "--", "src/x.ts"]);
  });

  it.each([["-x"], ["../../etc/passwd"], ["/etc/passwd"]])(
    "rejects path=%s with 400 invalid_path and never spawns a diff for it",
    async (badPath) => {
      const { runner, calls } = makeFakeRunner({ diffOutput: "should never be returned" });
      app = await buildServerWithGit(runner);
      const cookie = await loginCookieHeader(app);
      const { session } = await createProjectAndSession(app, cookie);

      const res = await app.inject({
        method: "GET",
        url: `/api/sessions/${session.id}/diff?path=${encodeURIComponent(badPath)}`,
        headers: { cookie },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: "invalid_path" });
      expect(calls.some((c) => c[0] === "diff")).toBe(false);
    },
  );

  it("404s for an unknown session id", async () => {
    const { runner } = makeFakeRunner();
    app = await buildServerWithGit(runner);
    const cookie = await loginCookieHeader(app);
    const res = await app.inject({
      method: "GET",
      url: "/api/sessions/00000000-0000-0000-0000-000000000000/diff",
      headers: { cookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it("401s without the session cookie", async () => {
    const { runner } = makeFakeRunner();
    app = await buildServerWithGit(runner);
    const res = await app.inject({ method: "GET", url: "/api/sessions/anything/diff" });
    expect(res.statusCode).toBe(401);
  });
});

describe("GET /api/sessions/:id/artifacts", () => {
  it("returns an empty list when no artifact_created events exist", async () => {
    const { runner } = makeFakeRunner();
    app = await buildServerWithGit(runner);
    const cookie = await loginCookieHeader(app);
    const { session } = await createProjectAndSession(app, cookie);

    const res = await app.inject({ method: "GET", url: `/api/sessions/${session.id}/artifacts`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ artifacts: [] });
  });

  it("returns an artifact after an artifact_created event is appended to the store", async () => {
    const store = new EventStore(":memory:");
    const adapters = createTestRegistry();
    const { runner } = makeFakeRunner();
    app = await buildServer({
      store,
      adapters,
      password: TEST_PASSWORD,
      version: "test",
      gitService: new GitService(runner),
    });
    const cookie = await loginCookieHeader(app);
    const { session } = await createProjectAndSession(app, cookie);

    const appended = store.appendEvent(session.id, {
      source: "agentdeck",
      type: "artifact_created",
      artifactType: "screenshot",
      path: "/tmp/agentdeck-git-review-test/screenshot.png",
      mimeType: "image/png",
    });

    const res = await app.inject({ method: "GET", url: `/api/sessions/${session.id}/artifacts`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      artifacts: [
        {
          id: appended.id,
          sequence: appended.sequence,
          timestamp: appended.timestamp,
          artifactType: "screenshot",
          path: "/tmp/agentdeck-git-review-test/screenshot.png",
          mimeType: "image/png",
        },
      ],
    });
  });

  it("404s for an unknown session id", async () => {
    const { runner } = makeFakeRunner();
    app = await buildServerWithGit(runner);
    const cookie = await loginCookieHeader(app);
    const res = await app.inject({
      method: "GET",
      url: "/api/sessions/00000000-0000-0000-0000-000000000000/artifacts",
      headers: { cookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it("401s without the session cookie", async () => {
    const { runner } = makeFakeRunner();
    app = await buildServerWithGit(runner);
    const res = await app.inject({ method: "GET", url: "/api/sessions/anything/artifacts" });
    expect(res.statusCode).toBe(401);
  });
});
