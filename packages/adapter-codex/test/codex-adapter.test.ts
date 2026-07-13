import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { CodexAdapter } from "../src/codex-adapter.js";
import { SERVER_REQUEST_METHODS, textInput } from "../src/proto.js";
import type {
  ExitInfo,
  ExitListener,
  NotificationListener,
  ServerRequestHandler,
  TransportLike,
} from "../src/transport.js";
import type { RequestId, WireServerRequest } from "../src/proto.js";
import type { AgentEvent, AgentEventOf } from "@agentdeck/shared";

/**
 * Injected fake transport (design §9) — no real `codex` process. Implements `TransportLike`
 * exactly, records everything sent/notified in call order, and gives the test direct hooks to
 * drive notifications, server-requests, and process exit.
 */
class FakeTransport implements TransportLike {
  readonly sent: Array<{ method: string; params?: unknown }> = [];
  closeCalled = false;

  private notificationListener: NotificationListener | undefined;
  private serverRequestHandler: ServerRequestHandler | undefined;
  private readonly exitListeners = new Set<ExitListener>();
  private readonly responses: Record<string, unknown>;

  constructor(responses: Record<string, unknown> = {}) {
    this.responses = {
      initialize: {},
      "thread/start": { thread: { id: "thread-abc" }, model: "gpt-5-codex" },
      "thread/resume": {},
      "turn/start": {},
      "turn/interrupt": {},
      "thread/list": {},
      ...responses,
    };
  }

  async start(): Promise<void> {}

  async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    this.sent.push({ method, params });
    return this.responses[method] as T;
  }

  notify(method: string, params?: unknown): void {
    this.sent.push({ method, params });
  }

  onNotification(listener: NotificationListener): () => void {
    this.notificationListener = listener;
    return () => {
      if (this.notificationListener === listener) this.notificationListener = undefined;
    };
  }

  /** Test helper: drive a server-> client notification. */
  emit(method: string, params: unknown): void {
    this.notificationListener?.({ method, params });
  }

  setServerRequestHandler(handler: ServerRequestHandler): void {
    this.serverRequestHandler = handler;
  }

  /** Test helper: drive a server-initiated request; returns the eventual wire response. */
  serverRequest(id: RequestId, method: string, params: unknown): Promise<unknown> {
    if (!this.serverRequestHandler) throw new Error("FakeTransport: no server-request handler registered");
    const req: WireServerRequest = { id, method, params };
    return Promise.resolve(this.serverRequestHandler(req));
  }

  onExit(listener: ExitListener): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  /** Test helper: drive process termination. */
  fireExit(info: ExitInfo): void {
    for (const l of this.exitListeners) l(info);
  }

  hasExitListener(): boolean {
    return this.exitListeners.size > 0;
  }

  async close(): Promise<void> {
    this.closeCalled = true;
  }
}

const NOW = "2026-07-13T00:00:00.000Z";

function setup(responses?: Record<string, unknown>): { fake: FakeTransport; adapter: CodexAdapter } {
  const fake = new FakeTransport(responses);
  const adapter = new CodexAdapter({
    transportFactory: () => fake,
    // AgentEventSchema requires `id` to be a real uuid (events.ts), so the deterministic
    // override still has to mint real uuids, not an "id-1", "id-2", ... counter.
    idGenerator: () => randomUUID(),
    now: () => NOW,
  });
  return { fake, adapter };
}

function statusChanges(events: AgentEvent[]): AgentEventOf<"session_status_changed">[] {
  return events.filter((e): e is AgentEventOf<"session_status_changed"> => e.type === "session_status_changed");
}

describe("CodexAdapter (fake transport, no real codex process)", () => {
  let sid: string;

  beforeEach(() => {
    sid = randomUUID();
  });

  it("startSession: initialize -> initialized -> thread/start -> turn/start, in order; emits session_started; returns the handle", async () => {
    const { fake, adapter } = setup();
    const events: AgentEvent[] = [];
    adapter.subscribe(sid, (e) => events.push(e));

    const handle = await adapter.startSession({ sessionId: sid, workingDirectory: "/tmp/x", prompt: "hi" });

    expect(fake.sent.map((s) => s.method)).toEqual(["initialize", "initialized", "thread/start", "turn/start"]);
    const turnStart = fake.sent.find((s) => s.method === "turn/start");
    expect(turnStart?.params).toEqual({ threadId: "thread-abc", input: textInput("hi") });

    const started = events.find((e) => e.type === "session_started");
    expect(started).toMatchObject({ type: "session_started", externalSessionId: "thread-abc" });

    expect(handle).toEqual({ sessionId: sid, externalSessionId: "thread-abc" });
  });

  it("turn/started notification -> session_status_changed running (previous starting)", async () => {
    const { fake, adapter } = setup();
    const events: AgentEvent[] = [];
    adapter.subscribe(sid, (e) => events.push(e));
    await adapter.startSession({ sessionId: sid, workingDirectory: "/tmp/x", prompt: "hi" });

    fake.emit("turn/started", { threadId: "thread-abc", turn: { id: "turn-1" } });

    const changes = statusChanges(events);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ status: "running", previous: "starting" });
  });

  it("assistant message streaming: item/started (agentMessage) then two deltas -> two assistant_message events", async () => {
    const { fake, adapter } = setup();
    const events: AgentEvent[] = [];
    adapter.subscribe(sid, (e) => events.push(e));
    await adapter.startSession({ sessionId: sid, workingDirectory: "/tmp/x", prompt: "hi" });

    fake.emit("item/started", { threadId: "thread-abc", turnId: "turn-1", item: { type: "agentMessage", id: "m1", phase: "final_answer" } });
    fake.emit("item/agentMessage/delta", { threadId: "thread-abc", turnId: "turn-1", itemId: "m1", delta: "Hel" });
    fake.emit("item/agentMessage/delta", { threadId: "thread-abc", turnId: "turn-1", itemId: "m1", delta: "lo" });

    const assistantMessages = events.filter((e): e is AgentEventOf<"assistant_message"> => e.type === "assistant_message");
    expect(assistantMessages).toHaveLength(2);
    expect(assistantMessages.map((e) => e.text)).toEqual(["Hel", "lo"]);
    expect(assistantMessages.every((e) => e.phase === "delta")).toBe(true);
  });

  it("approval round-trip: waiting_for_approval then approval_requested, wire stays pending until approve(), then back to running and wire resolves with the decision", async () => {
    const { fake, adapter } = setup();
    const events: AgentEvent[] = [];
    adapter.subscribe(sid, (e) => events.push(e));
    await adapter.startSession({ sessionId: sid, workingDirectory: "/tmp/x", prompt: "hi" });
    fake.emit("turn/started", { threadId: "thread-abc", turn: { id: "turn-1" } }); // -> running, so waiting_for_approval is a legal transition
    events.length = 0;

    const wire = fake.serverRequest(7, SERVER_REQUEST_METHODS.commandApproval, {
      threadId: "thread-abc",
      turnId: "turn-1",
      itemId: "i1",
      command: "ls",
      cwd: "/tmp/x",
      availableDecisions: ["accept", "decline"],
    });

    let settled = false;
    void wire.then(() => {
      settled = true;
    });

    expect(events.map((e) => e.type)).toEqual(["session_status_changed", "approval_requested"]);
    expect(events[0]).toMatchObject({ status: "waiting_for_approval" });

    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false); // still pending: approve() has not been called yet

    await adapter.approve(sid, { requestId: "7", optionId: "accept" });

    const changes = statusChanges(events);
    expect(changes[changes.length - 1]).toMatchObject({ status: "running", previous: "waiting_for_approval" });
    await expect(wire).resolves.toEqual({ decision: "accept" });
  });

  it("turn/completed -> session_status_changed completed", async () => {
    const { fake, adapter } = setup();
    const events: AgentEvent[] = [];
    adapter.subscribe(sid, (e) => events.push(e));
    await adapter.startSession({ sessionId: sid, workingDirectory: "/tmp/x", prompt: "hi" });
    fake.emit("turn/started", { threadId: "thread-abc", turn: { id: "turn-1" } });

    fake.emit("turn/completed", { threadId: "thread-abc", turn: { id: "turn-1", status: "completed" } });

    const changes = statusChanges(events);
    expect(changes[changes.length - 1]).toMatchObject({ status: "completed", previous: "running" });
  });

  it("sendMessage sends turn/start but emits no user_message itself; the codex echo (item/started userMessage) is the single source", async () => {
    const { fake, adapter } = setup();
    const events: AgentEvent[] = [];
    adapter.subscribe(sid, (e) => events.push(e));
    await adapter.startSession({ sessionId: sid, workingDirectory: "/tmp/x", prompt: "hi" });
    fake.emit("turn/started", { threadId: "thread-abc", turn: { id: "turn-1" } });
    fake.emit("turn/completed", { threadId: "thread-abc", turn: { id: "turn-1", status: "completed" } });
    events.length = 0;

    await adapter.sendMessage(sid, "again");

    const turnStarts = fake.sent.filter((s) => s.method === "turn/start");
    expect(turnStarts[turnStarts.length - 1]?.params).toEqual({ threadId: "thread-abc", input: textInput("again") });
    expect(events.some((e) => e.type === "user_message")).toBe(false);

    fake.emit("item/started", {
      threadId: "thread-abc",
      turnId: "turn-1",
      item: { type: "userMessage", id: "u1", content: [{ type: "text", text: "again" }] },
    });

    const userMessages = events.filter((e): e is AgentEventOf<"user_message"> => e.type === "user_message");
    expect(userMessages).toHaveLength(1);
    expect(userMessages[0]?.text).toBe("again");
  });

  it("crash: process exit rejects a pending approval and emits an unrecoverable error + failed", async () => {
    const { fake, adapter } = setup();
    const events: AgentEvent[] = [];
    adapter.subscribe(sid, (e) => events.push(e));
    await adapter.startSession({ sessionId: sid, workingDirectory: "/tmp/x", prompt: "hi" });
    fake.emit("turn/started", { threadId: "thread-abc", turn: { id: "turn-1" } });

    const wire = fake.serverRequest(9, SERVER_REQUEST_METHODS.commandApproval, {
      threadId: "thread-abc",
      turnId: "turn-1",
      itemId: "i1",
      command: "rm -rf /",
      cwd: "/tmp/x",
      availableDecisions: ["accept", "decline"],
    });
    const wireRejection = wire.then(
      () => "resolved",
      () => "rejected",
    );

    fake.fireExit({ code: 1, signal: null });

    const errorEvent = events.find((e) => e.type === "error");
    expect(errorEvent).toMatchObject({ type: "error", recoverable: false });

    const changes = statusChanges(events);
    expect(changes[changes.length - 1]).toMatchObject({ status: "failed" });

    await expect(wireRejection).resolves.toBe("rejected");
  });

  it("stop: emits stopped, closes the transport, and unsubscribes the exit listener (a post-stop exit produces no further events)", async () => {
    const { fake, adapter } = setup();
    const events: AgentEvent[] = [];
    adapter.subscribe(sid, (e) => events.push(e));
    await adapter.startSession({ sessionId: sid, workingDirectory: "/tmp/x", prompt: "hi" });
    fake.emit("turn/started", { threadId: "thread-abc", turn: { id: "turn-1" } });

    await adapter.stop(sid);

    const changes = statusChanges(events);
    expect(changes[changes.length - 1]).toMatchObject({ status: "stopped" });
    expect(fake.closeCalled).toBe(true);
    expect(fake.hasExitListener()).toBe(false);

    const countBefore = events.length;
    fake.fireExit({ code: 1, signal: null });
    expect(events.length).toBe(countBefore);
  });

  it("coalesces a repeated turn/completed (no-op) and allows completed -> running on a fresh turn/started", async () => {
    const { fake, adapter } = setup();
    const events: AgentEvent[] = [];
    adapter.subscribe(sid, (e) => events.push(e));
    await adapter.startSession({ sessionId: sid, workingDirectory: "/tmp/x", prompt: "hi" });
    fake.emit("turn/started", { threadId: "thread-abc", turn: { id: "turn-1" } });
    fake.emit("turn/completed", { threadId: "thread-abc", turn: { id: "turn-1", status: "completed" } });

    // Second turn/completed while already completed: same-status draft is coalesced away (no-op).
    fake.emit("turn/completed", { threadId: "thread-abc", turn: { id: "turn-1", status: "completed" } });

    const completedChanges = statusChanges(events).filter((e) => e.status === "completed");
    expect(completedChanges).toHaveLength(1);

    // A fresh turn on the same (now-completed) session is a legal completed -> running transition.
    fake.emit("turn/started", { threadId: "thread-abc", turn: { id: "turn-2" } });
    const changes = statusChanges(events);
    expect(changes[changes.length - 1]).toMatchObject({ status: "running", previous: "completed" });
  });
});
