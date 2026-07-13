import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { InvalidTransitionError, type AgentEvent } from "@agentdeck/shared";
import { EventStore, type NewEvent } from "../src/index.js";

let store: EventStore;

beforeEach(() => {
  store = new EventStore(":memory:");
});

afterEach(() => {
  store.close();
});

function makeProjectAndSession() {
  const project = store.createProject({ name: "agentdeck", repositoryPath: "/repo" });
  const session = store.createSession({
    projectId: project.id,
    agentKind: "claude",
    workingDirectory: "/repo",
  });
  return { project, session };
}

const sessionStarted = (): NewEvent => ({
  type: "session_started",
  source: "claude",
  title: "test session",
});

describe("EventStore — projects and sessions", () => {
  it("creates and reads back a project", () => {
    const project = store.createProject({ name: "agentdeck", repositoryPath: "/repo" });
    expect(store.getProject(project.id)).toEqual(project);
    expect(store.listProjects()).toEqual([project]);
  });

  it("creates a session defaulting to status starting", () => {
    const { session } = makeProjectAndSession();
    expect(session.status).toBe("starting");
    expect(store.getSession(session.id)).toEqual(session);
    expect(store.listSessions(session.projectId)).toEqual([session]);
  });

  it("routes status changes through assertTransition and throws on an illegal jump", () => {
    const { session } = makeProjectAndSession();
    const running = store.updateSessionStatus(session.id, "running");
    expect(running.status).toBe("running");

    const stopped = store.updateSessionStatus(session.id, "stopped");
    expect(stopped.status).toBe("stopped");
    expect(stopped.endedAt).toBeDefined();

    // stopped is terminal — nothing may follow it.
    expect(() => store.updateSessionStatus(session.id, "running")).toThrow(InvalidTransitionError);
  });
});

describe("EventStore — appendEvent / getEventsSince", () => {
  it("assigns a monotonic per-session sequence starting at 1", () => {
    const { session } = makeProjectAndSession();
    const e1 = store.appendEvent(session.id, sessionStarted());
    const e2 = store.appendEvent(session.id, { type: "user_message", source: "agentdeck", text: "hi" });
    const e3 = store.appendEvent(session.id, {
      type: "session_status_changed",
      source: "agentdeck",
      status: "running",
    });
    expect([e1.sequence, e2.sequence, e3.sequence]).toEqual([1, 2, 3]);
    expect(store.getHeadSequence(session.id)).toBe(3);
  });

  it("keeps sequences independent per session", () => {
    const { session: s1 } = makeProjectAndSession();
    const { session: s2 } = makeProjectAndSession();
    store.appendEvent(s1.id, sessionStarted());
    const e = store.appendEvent(s2.id, sessionStarted());
    expect(e.sequence).toBe(1);
    expect(store.getHeadSequence(s1.id)).toBe(1);
    expect(store.getHeadSequence(s2.id)).toBe(1);
  });

  it("getEventsSince fills a gap with no missing or duplicate sequences, ascending", () => {
    const { session } = makeProjectAndSession();
    const appended = [
      sessionStarted(),
      { type: "user_message" as const, source: "agentdeck" as const, text: "go" },
      { type: "session_status_changed" as const, source: "agentdeck" as const, status: "running" as const },
      { type: "test_result" as const, source: "claude" as const, passed: 3, failed: 0 },
    ].map((e) => store.appendEvent(session.id, e));

    const replay = store.getEventsSince(session.id, 1);
    expect(replay.map((e) => e.sequence)).toEqual([2, 3, 4]);
    expect(replay).toEqual(appended.slice(1));
  });

  it("returns [] when lastSeq is at or beyond head", () => {
    const { session } = makeProjectAndSession();
    store.appendEvent(session.id, sessionStarted());
    expect(store.getEventsSince(session.id, 1)).toEqual([]);
    expect(store.getEventsSince(session.id, 99)).toEqual([]);
  });

  it("does not produce duplicate or gapped sequences under concurrent-style appends", async () => {
    const { session } = makeProjectAndSession();
    const results = await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        Promise.resolve().then(() =>
          store.appendEvent(session.id, { type: "user_message", source: "agentdeck", text: `msg ${i}` }),
        ),
      ),
    );
    const sequences = results.map((e) => e.sequence).sort((a, b) => a - b);
    expect(sequences).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
    expect(new Set(sequences).size).toBe(25);
    expect(store.getHeadSequence(session.id)).toBe(25);
  });

  it("enforces UNIQUE(session_id, sequence) at the SQLite layer", () => {
    const { session } = makeProjectAndSession();
    store.appendEvent(session.id, sessionStarted());
    // Reach past the public API to attempt a literal duplicate sequence.
    const sqlite = (store as unknown as { opened: { sqlite: import("better-sqlite3").Database } }).opened
      .sqlite;
    expect(() =>
      sqlite
        .prepare(
          `INSERT INTO agent_events (id, session_id, sequence, timestamp, source, type, payload)
           VALUES (?, ?, 1, ?, 'agentdeck', 'user_message', '{"text":"dup"}')`,
        )
        .run(randomUUID(), session.id, new Date().toISOString()),
    ).toThrow(/UNIQUE/i);
  });

  it("round-trips every representative event type through append -> read", () => {
    const { session } = makeProjectAndSession();
    const inputs: NewEvent[] = [
      { type: "session_started", source: "claude", title: "t", model: "sonnet", externalSessionId: "ext-1" },
      { type: "session_status_changed", source: "agentdeck", status: "running", previous: "starting" },
      { type: "assistant_message", source: "claude", itemId: "m1", text: "hello", phase: "delta" },
      { type: "assistant_message", source: "claude", itemId: "m1", text: "hello world", phase: "final" },
      { type: "user_message", source: "agentdeck", text: "do the thing" },
      { type: "reasoning", source: "claude", itemId: "r1", text: "thinking...", phase: "final" },
      { type: "command_started", source: "claude", commandId: "c1", command: "ls -la", cwd: "/repo" },
      { type: "command_output", source: "claude", commandId: "c1", chunk: "file.txt\n", stream: "stdout" },
      { type: "command_completed", source: "claude", commandId: "c1", exitCode: 0, durationMs: 12.5 },
      { type: "tool_started", source: "claude", toolCallId: "tc1", toolName: "Read", input: { path: "a" } },
      { type: "tool_output", source: "claude", toolCallId: "tc1", output: { ok: true }, ok: true },
      { type: "file_changed", source: "claude", path: "a.ts", changeType: "modified", diff: "@@ -1 +1 @@" },
      {
        type: "approval_requested",
        source: "claude",
        request: {
          requestId: "req-1",
          kind: "command",
          summary: "run rm -rf /tmp/x",
          options: [
            { id: "accept", label: "Allow", kind: "allow" },
            { id: "deny", label: "Deny", kind: "deny" },
          ],
        },
      },
      { type: "user_input_requested", source: "claude", requestId: "ui-1", prompt: "which branch?", questions: ["main or dev?"] },
      { type: "test_result", source: "claude", passed: 10, failed: 1, total: 11, summary: "1 failure" },
      { type: "artifact_created", source: "claude", artifactType: "screenshot", path: "/tmp/s.png", mimeType: "image/png" },
      { type: "error", source: "claude", message: "boom", recoverable: true },
    ];

    const appended = inputs.map((e) => store.appendEvent(session.id, e));
    const read = store.getEventsSince(session.id, 0);
    expect(read).toEqual(appended);

    // Spot-check that type-specific fields survived the JSON payload round trip exactly.
    const approval = read.find((e): e is AgentEvent & { type: "approval_requested" } => e.type === "approval_requested");
    expect(approval?.request.options).toEqual([
      { id: "accept", label: "Allow", kind: "allow" },
      { id: "deny", label: "Deny", kind: "deny" },
    ]);
  });

  it("stamps id and timestamp when the caller omits them, and always assigns sessionId", () => {
    const { session } = makeProjectAndSession();
    const event = store.appendEvent(session.id, sessionStarted());
    expect(event.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(event.sessionId).toBe(session.id);
    expect(() => new Date(event.timestamp).toISOString()).not.toThrow();
  });
});
