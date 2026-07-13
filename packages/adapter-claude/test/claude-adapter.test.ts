import { randomUUID } from "node:crypto";
import { describe, expect, it, beforeEach } from "vitest";
import type { AgentEvent } from "@agentdeck/shared";
import { ClaudeAdapter } from "../src/claude-adapter.js";
import type {
  ClaudeTransportLike,
  ClaudeTransportOptions,
  MessageListener,
  ExitListener,
} from "../src/transport.js";

// A hand-rolled transport double — no SDK, no process. Lets a test drive the message/exit streams
// and invoke the adapter-supplied canUseTool, and records sends/interrupts/closes. Mirrors
// adapter-codex's FakeTransport.
class FakeTransport implements ClaudeTransportLike {
  sends: string[] = [];
  started = false;
  closed = false;
  interrupts = 0;
  private readonly msgListeners = new Set<MessageListener>();
  private readonly exitListeners = new Set<ExitListener>();
  constructor(public readonly opts: ClaudeTransportOptions) {}
  start(): void {
    this.started = true;
  }
  send(text: string): void {
    this.sends.push(text);
  }
  async interrupt(): Promise<void> {
    this.interrupts++;
  }
  async close(): Promise<void> {
    this.closed = true;
  }
  onMessage(l: MessageListener) {
    this.msgListeners.add(l);
    return () => this.msgListeners.delete(l);
  }
  onExit(l: ExitListener) {
    this.exitListeners.add(l);
    return () => this.exitListeners.delete(l);
  }
  // --- test drivers ---
  emitMsg(m: unknown): void {
    for (const l of this.msgListeners) l(m as never);
  }
  fireExit(info: { error?: Error }): void {
    for (const l of this.exitListeners) l(info);
  }
  callCanUseTool(name: string, input: Record<string, unknown>, ctx: Record<string, unknown> = {}) {
    return this.opts.canUseTool(name, input, { signal: new AbortController().signal, ...ctx } as never);
  }
}

const NOW = "2026-07-13T00:00:00.000Z";
const S1 = randomUUID();
const S2 = randomUUID();
function init(sessionId: string, model = "claude-haiku-4-5-20251001") {
  return { type: "system", subtype: "init", session_id: sessionId, model, cwd: "/tmp", tools: [], mcp_servers: [] };
}
function assistantText(id: string, text: string) {
  return { type: "assistant", message: { id, type: "message", role: "assistant", content: [{ type: "text", text }] }, parent_tool_use_id: null };
}
function resultSuccess() {
  return { type: "result", subtype: "success", is_error: false, result: "ok" };
}

describe("ClaudeAdapter", () => {
  let fake: FakeTransport;
  let adapter: ClaudeAdapter;
  let events: AgentEvent[];
  let seq: number;

  beforeEach(() => {
    fake = undefined as unknown as FakeTransport;
    seq = 0;
    adapter = new ClaudeAdapter({
      transportFactory: (opts) => (fake = new FakeTransport(opts)),
      idGenerator: () => randomUUID(),
      now: () => NOW,
    });
    events = [];
  });

  async function start(prompt = "hello", model?: string) {
    const unsub = adapter.subscribe(S1, (e) => events.push(e));
    const handle = await adapter.startSession({ sessionId: S1, workingDirectory: "/repo", prompt, model });
    return { unsub, handle };
  }

  it("starts the transport, sends the initial prompt, and emits a user_message for it", async () => {
    await start("do the thing");
    expect(fake.started).toBe(true);
    expect(fake.sends).toEqual(["do the thing"]);
    expect(fake.opts.cwd).toBe("/repo");
    expect(events.filter((e) => e.type === "user_message").map((e) => (e as { text: string }).text)).toEqual(["do the thing"]);
  });

  it("emits session_started (with externalSessionId) + running on the first init message", async () => {
    await start();
    fake.emitMsg(init("ext-123", "claude-opus-4-8"));
    const started = events.find((e) => e.type === "session_started");
    expect(started).toMatchObject({ type: "session_started", externalSessionId: "ext-123", model: "claude-opus-4-8", source: "claude" });
    expect(events.some((e) => e.type === "session_status_changed" && e.status === "running")).toBe(true);
  });

  it("maps assistant text and a successful result into the event stream", async () => {
    await start();
    fake.emitMsg(init("ext-1"));
    fake.emitMsg(assistantText("m1", "the answer"));
    fake.emitMsg(resultSuccess());
    expect(events.some((e) => e.type === "assistant_message" && (e as { text: string }).text === "the answer")).toBe(true);
    expect(events.some((e) => e.type === "session_status_changed" && e.status === "completed")).toBe(true);
  });

  it("runs a full approval round-trip: canUseTool parks, approve() resolves it to allow", async () => {
    await start();
    fake.emitMsg(init("ext-1"));
    const decision = fake.callCanUseTool("Bash", { command: "ls" });
    // approval surfaced with a status flip
    const reqEvent = events.find((e) => e.type === "approval_requested") as Extract<AgentEvent, { type: "approval_requested" }>;
    expect(reqEvent).toBeTruthy();
    expect(events.some((e) => e.type === "session_status_changed" && e.status === "waiting_for_approval")).toBe(true);

    await adapter.approve(S1, { requestId: reqEvent.request.requestId, optionId: "allow" });
    await expect(decision).resolves.toEqual({ behavior: "allow", updatedInput: { command: "ls" } });
    // approving leaves the waiting state
    expect(events.some((e, i) => e.type === "session_status_changed" && e.status === "running" && i > events.indexOf(reqEvent))).toBe(true);
  });

  it("sendMessage sends to the transport and emits the user_message", async () => {
    await start();
    fake.emitMsg(init("ext-1"));
    fake.emitMsg(resultSuccess());
    await adapter.sendMessage(S1, "follow up");
    expect(fake.sends).toEqual(["hello", "follow up"]);
    expect(events.filter((e) => e.type === "user_message").map((e) => (e as { text: string }).text)).toEqual(["hello", "follow up"]);
  });

  it("interrupt calls the transport and pauses a running turn", async () => {
    await start();
    fake.emitMsg(init("ext-1")); // status -> running
    await adapter.interrupt(S1);
    expect(fake.interrupts).toBe(1);
    expect(events.some((e) => e.type === "session_status_changed" && e.status === "paused")).toBe(true);
  });

  it("stop unsubscribes exit, emits stopped, closes the transport, and denies pending approvals", async () => {
    await start();
    fake.emitMsg(init("ext-1"));
    const decision = fake.callCanUseTool("Bash", { command: "ls" });
    await adapter.stop(S1);
    expect(fake.closed).toBe(true);
    expect(events.some((e) => e.type === "session_status_changed" && e.status === "stopped")).toBe(true);
    await expect(decision).resolves.toMatchObject({ behavior: "deny" });
    // a post-stop exit must not produce more events (offExit unsubscribed)
    const count = events.length;
    fake.fireExit({ error: new Error("late") });
    expect(events.length).toBe(count);
  });

  it("a transport crash surfaces an error + failed and denies pending approvals", async () => {
    await start();
    fake.emitMsg(init("ext-1"));
    const decision = fake.callCanUseTool("Bash", { command: "ls" });
    fake.fireExit({ error: new Error("claude died") });
    expect(events.some((e) => e.type === "error" && (e as { message: string }).message.includes("claude died"))).toBe(true);
    expect(events.some((e) => e.type === "session_status_changed" && e.status === "failed")).toBe(true);
    await expect(decision).resolves.toMatchObject({ behavior: "deny" });
  });

  it("shutdown stops every live session", async () => {
    const unsub = adapter.subscribe(S1, (e) => events.push(e));
    await adapter.startSession({ sessionId: S1, workingDirectory: "/repo", prompt: "x" });
    await adapter.shutdown();
    expect(fake.closed).toBe(true);
    unsub();
  });

  it("resumeSession passes the externalSessionId to the transport as resume", async () => {
    adapter.subscribe(S2, (e) => events.push(e));
    await adapter.resumeSession({ sessionId: S2, externalSessionId: "ext-old", workingDirectory: "/repo", prompt: "again" });
    expect(fake.opts.resume).toBe("ext-old");
    expect(fake.sends).toEqual(["again"]);
  });

  it("coalesces status: a duplicate completed and an illegal transition are dropped, not thrown", async () => {
    await start();
    fake.emitMsg(init("ext-1"));
    fake.emitMsg(resultSuccess());
    const before = events.length;
    fake.emitMsg(resultSuccess()); // completed -> completed: no-op
    expect(events.length).toBe(before);
  });
});
