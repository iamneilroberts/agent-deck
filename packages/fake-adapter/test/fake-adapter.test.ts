import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeEach } from "vitest";
import { AgentEventSchema, type AgentEvent, type AgentEventType } from "@agentdeck/shared";
import { FakeAdapter, APPROVAL_REQUEST_ID } from "../src/index.js";

function collector() {
  const events: AgentEvent[] = [];
  return { events, listener: (e: AgentEvent) => events.push(e) };
}

/** Waits until `predicate(events)` is true or `timeoutMs` elapses. */
async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor: timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

let adapter: FakeAdapter;

beforeEach(() => {
  adapter = new FakeAdapter({ tickIntervalMs: 1 });
});

describe("FakeAdapter — basics", () => {
  it("reports itself installed", async () => {
    await expect(adapter.detectInstallation()).resolves.toEqual({
      installed: true,
      version: "fake-adapter",
      authenticated: true,
    });
  });

  it("every emitted event validates against AgentEventSchema", async () => {
    const sessionId = randomUUID();
    const { events, listener } = collector();
    await adapter.startSession({ sessionId, workingDirectory: "/repo" });
    adapter.subscribe(sessionId, listener);
    await waitFor(() => events.some((e) => e.type === "approval_requested"));
    for (const e of events) {
      expect(() => AgentEventSchema.parse(e)).not.toThrow();
      expect(e.sessionId).toBe(sessionId);
    }
  });
});

describe("FakeAdapter — scripted stream", () => {
  it("emits the expected ordered event types up to the approval pause", async () => {
    const sessionId = randomUUID();
    const { events, listener } = collector();
    adapter.subscribe(sessionId, listener);
    await adapter.startSession({ sessionId, workingDirectory: "/repo" });
    await waitFor(() => events.some((e) => e.type === "approval_requested"));

    const types: AgentEventType[] = events.map((e) => e.type);
    expect(types).toEqual([
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
  });

  it("pauses at approval_requested until approve() is called, then completes", async () => {
    const sessionId = randomUUID();
    const { events, listener } = collector();
    adapter.subscribe(sessionId, listener);
    await adapter.startSession({ sessionId, workingDirectory: "/repo" });
    await waitFor(() => events.some((e) => e.type === "approval_requested"));

    const countAtPause = events.length;
    // Give the scheduler several extra ticks — nothing should arrive without approve().
    await new Promise((r) => setTimeout(r, 30));
    expect(events.length).toBe(countAtPause);

    await adapter.approve(sessionId, { requestId: APPROVAL_REQUEST_ID, optionId: "accept" });
    await waitFor(() => events.some((e) => e.type === "session_status_changed" && e.status === "completed"));

    const resumed = events.slice(countAtPause).map((e) => e.type);
    expect(resumed).toEqual([
      "session_status_changed",
      "assistant_message",
      "assistant_message",
      "test_result",
      "session_status_changed",
    ]);
    const last = events.at(-1);
    expect(last?.type === "session_status_changed" && last.status).toBe("completed");
  });

  it("rejects approve() with an optionId the request did not offer", async () => {
    const sessionId = randomUUID();
    const { events, listener } = collector();
    adapter.subscribe(sessionId, listener);
    await adapter.startSession({ sessionId, workingDirectory: "/repo" });
    await waitFor(() => events.some((e) => e.type === "approval_requested"));

    await expect(
      adapter.approve(sessionId, { requestId: APPROVAL_REQUEST_ID, optionId: "not-an-option" }),
    ).rejects.toThrow(/not-an-option/);

    // Rejected decision must not resume the script.
    const countAfterReject = events.length;
    await new Promise((r) => setTimeout(r, 30));
    expect(events.length).toBe(countAfterReject);
  });

  it("rejects approve() for a mismatched requestId", async () => {
    const sessionId = randomUUID();
    const { events, listener } = collector();
    adapter.subscribe(sessionId, listener);
    await adapter.startSession({ sessionId, workingDirectory: "/repo" });
    await waitFor(() => events.some((e) => e.type === "approval_requested"));

    await expect(adapter.approve(sessionId, { requestId: "wrong-id", optionId: "accept" })).rejects.toThrow();
  });
});

describe("FakeAdapter — interrupt / stop", () => {
  it("interrupt ends the in-flight turn cleanly without further events", async () => {
    const sessionId = randomUUID();
    const { events, listener } = collector();
    adapter.subscribe(sessionId, listener);
    await adapter.startSession({ sessionId, workingDirectory: "/repo" });
    await waitFor(() => events.length >= 3);

    await adapter.interrupt(sessionId);
    const countAtInterrupt = events.length;
    await new Promise((r) => setTimeout(r, 30));
    // Only the paused status-change event (if any) may have been appended; the script does not resume.
    expect(events.length).toBeLessThanOrEqual(countAtInterrupt + 1);
    const last = events.at(-1);
    if (events.length === countAtInterrupt + 1) {
      expect(last?.type === "session_status_changed" && last.status).toBe("paused");
    }
  });

  it("stop ends the stream cleanly and unsubscribes listeners", async () => {
    const sessionId = randomUUID();
    const { events, listener } = collector();
    adapter.subscribe(sessionId, listener);
    await adapter.startSession({ sessionId, workingDirectory: "/repo" });
    await waitFor(() => events.length >= 3);

    await adapter.stop(sessionId);
    const last = events.at(-1);
    expect(last?.type === "session_status_changed" && last.status).toBe("stopped");

    const countAtStop = events.length;
    await new Promise((r) => setTimeout(r, 30));
    expect(events.length).toBe(countAtStop);
  });
});

describe("FakeAdapter — misc adapter surface", () => {
  it("sendMessage emits a user_message immediately", async () => {
    const sessionId = randomUUID();
    const { events, listener } = collector();
    adapter.subscribe(sessionId, listener);
    await adapter.startSession({ sessionId, workingDirectory: "/repo" });
    await adapter.sendMessage(sessionId, "hello there");

    const found = events.find((e) => e.type === "user_message" && e.text === "hello there");
    expect(found).toBeDefined();
  });

  it("answerUserInput rejects when nothing is pending", async () => {
    const sessionId = randomUUID();
    await adapter.startSession({ sessionId, workingDirectory: "/repo" });
    await expect(adapter.answerUserInput(sessionId, "req-x", "answer")).rejects.toThrow();
  });

  it("resumeSession reports the given externalSessionId and replays the script", async () => {
    const sessionId = randomUUID();
    const { events, listener } = collector();
    adapter.subscribe(sessionId, listener);
    const handle = await adapter.resumeSession({
      sessionId,
      externalSessionId: "vendor-ext-id",
      workingDirectory: "/repo",
    });
    expect(handle).toEqual({ sessionId, externalSessionId: "vendor-ext-id" });
    await waitFor(() => events.some((e) => e.type === "session_started"));
    const started = events.find((e) => e.type === "session_started");
    expect(started?.type === "session_started" && started.externalSessionId).toBe("vendor-ext-id");
  });

  it("listRecoverableSessions filters by workingDirectory when given", async () => {
    const a = randomUUID();
    const b = randomUUID();
    await adapter.startSession({ sessionId: a, workingDirectory: "/repo-a" });
    await adapter.startSession({ sessionId: b, workingDirectory: "/repo-b" });

    const all = await adapter.listRecoverableSessions();
    expect(all.map((r) => r.workingDirectory).sort()).toEqual(["/repo-a", "/repo-b"]);

    const onlyA = await adapter.listRecoverableSessions("/repo-a");
    expect(onlyA).toHaveLength(1);
    expect(onlyA[0]?.workingDirectory).toBe("/repo-a");
  });

  it("unsubscribe stops delivery to that listener", async () => {
    const sessionId = randomUUID();
    const { events, listener } = collector();
    const unsubscribe = adapter.subscribe(sessionId, listener);
    await adapter.startSession({ sessionId, workingDirectory: "/repo" });
    await waitFor(() => events.length >= 1);
    unsubscribe();
    const countAtUnsub = events.length;
    await new Promise((r) => setTimeout(r, 30));
    expect(events.length).toBe(countAtUnsub);
  });

  it("deterministic content: two independent sessions produce identical event shapes (minus id/sessionId/timestamp)", async () => {
    // `externalSessionId` on session_started embeds the (random) sessionId, so it varies
    // per run same as sessionId itself — strip it alongside the other per-session identifiers.
    const strip = (e: AgentEvent) => {
      const { id, sessionId, timestamp, ...rest } = e;
      if ("externalSessionId" in rest) {
        const { externalSessionId, ...withoutExternal } = rest;
        return withoutExternal;
      }
      return rest;
    };
    const runOne = async () => {
      const sessionId = randomUUID();
      const { events, listener } = collector();
      adapter.subscribe(sessionId, listener);
      await adapter.startSession({ sessionId, workingDirectory: "/repo" });
      await waitFor(() => events.some((e) => e.type === "approval_requested"));
      return events.map(strip);
    };
    const [first, second] = await Promise.all([runOne(), runOne()]);
    expect(first).toEqual(second);
  });
});
