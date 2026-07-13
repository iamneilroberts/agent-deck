import { describe, it, expect } from "vitest";
import { ClaudeTransport } from "../src/transport.js";
import type { ClaudeQueryParams, QueryFn } from "../src/transport.js";
import type { SDKMessage, CanUseTool } from "@anthropic-ai/claude-agent-sdk";

// No network, no real claude: queryFn is injected with a fake async generator that the test drives
// by hand (emit/finish/fail), mirroring how adapter-codex's transport tests drive a fake child
// process instead of a real `codex app-server`.

const flush = () => new Promise((r) => setTimeout(r, 0));
const noopCanUseTool: CanUseTool = async () => null;

/** A controllable stand-in for the SDK's `Query` (AsyncGenerator<SDKMessage, void> + interrupt()). */
class FakeQuery implements AsyncGenerator<SDKMessage, void> {
  interruptCalls = 0;
  private readonly queue: SDKMessage[] = [];
  private pending: { resolve: (r: IteratorResult<SDKMessage, void>) => void; reject: (e: unknown) => void } | null =
    null;
  private ended: { kind: "done" } | { kind: "error"; error: Error } | null = null;

  emit(msg: SDKMessage): void {
    if (this.pending) {
      const p = this.pending;
      this.pending = null;
      p.resolve({ value: msg, done: false });
    } else {
      this.queue.push(msg);
    }
  }

  finish(): void {
    if (this.ended) return;
    this.ended = { kind: "done" };
    if (this.pending) {
      const p = this.pending;
      this.pending = null;
      p.resolve({ value: undefined, done: true });
    }
  }

  fail(error: Error): void {
    if (this.ended) return;
    this.ended = { kind: "error", error };
    if (this.pending) {
      const p = this.pending;
      this.pending = null;
      p.reject(error);
    }
  }

  next(): Promise<IteratorResult<SDKMessage, void>> {
    if (this.queue.length > 0) {
      return Promise.resolve({ value: this.queue.shift() as SDKMessage, done: false });
    }
    if (this.ended?.kind === "done") return Promise.resolve({ value: undefined, done: true });
    if (this.ended?.kind === "error") return Promise.reject(this.ended.error);
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject };
    });
  }

  return(value?: void): Promise<IteratorResult<SDKMessage, void>> {
    return Promise.resolve({ value, done: true });
  }

  throw(e?: unknown): Promise<IteratorResult<SDKMessage, void>> {
    return Promise.reject(e);
  }

  interrupt = async (): Promise<unknown> => {
    this.interruptCalls++;
    return undefined;
  };

  [Symbol.asyncIterator](): AsyncGenerator<SDKMessage, void> {
    return this;
  }
}

function harness() {
  const calls: ClaudeQueryParams[] = [];
  const queries: FakeQuery[] = [];
  const queryFn: QueryFn = (params) => {
    calls.push(params);
    const q = new FakeQuery();
    queries.push(q);
    return q;
  };
  return { calls, queries, queryFn };
}

describe("ClaudeTransport", () => {
  it("routes every SDKMessage from the query stream to all onMessage listeners, in order", async () => {
    const { queryFn, queries } = harness();
    const t = new ClaudeTransport({ cwd: "/tmp", canUseTool: noopCanUseTool, queryFn });
    const received1: SDKMessage[] = [];
    const received2: SDKMessage[] = [];
    t.onMessage((m) => received1.push(m));
    t.onMessage((m) => received2.push(m));
    t.start();

    const m1 = { type: "system", subtype: "init" } as unknown as SDKMessage;
    const m2 = { type: "result", subtype: "success", is_error: false } as unknown as SDKMessage;
    queries[0]!.emit(m1);
    queries[0]!.emit(m2);
    queries[0]!.finish();
    await flush();

    expect(received1).toEqual([m1, m2]);
    expect(received2).toEqual([m1, m2]);
  });

  it("send(text) pushes an SDKUserMessage onto the streaming-input prompt; construction does not auto-send", async () => {
    const { queryFn, calls } = harness();
    const t = new ClaudeTransport({ cwd: "/tmp", canUseTool: noopCanUseTool, queryFn });
    t.start();

    const iterator = calls[0]!.prompt[Symbol.asyncIterator]();
    const pending = iterator.next();
    let resolved = false;
    void pending.then(() => {
      resolved = true;
    });
    await flush();
    expect(resolved).toBe(false); // nothing pushed yet — no auto-send on construction/start

    t.send("hello");
    const result = await pending;
    expect(result).toEqual({
      value: { type: "user", message: { role: "user", content: "hello" }, parent_tool_use_id: null },
      done: false,
    });
  });

  it("fires onExit exactly once with {} when the query stream completes", async () => {
    const { queryFn, queries } = harness();
    const t = new ClaudeTransport({ cwd: "/tmp", canUseTool: noopCanUseTool, queryFn });
    const exits: { error?: Error }[] = [];
    t.onExit((info) => exits.push(info));
    t.start();

    queries[0]!.finish();
    await flush();

    expect(exits).toEqual([{}]);
  });

  it("fires onExit with the thrown error when the query stream throws, and stops consuming", async () => {
    const { queryFn, queries } = harness();
    const t = new ClaudeTransport({ cwd: "/tmp", canUseTool: noopCanUseTool, queryFn });
    const exits: { error?: Error }[] = [];
    const received: SDKMessage[] = [];
    t.onMessage((m) => received.push(m));
    t.onExit((info) => exits.push(info));
    t.start();

    const boom = new Error("boom");
    queries[0]!.fail(boom);
    await flush();

    expect(exits).toHaveLength(1);
    expect(exits[0]?.error).toBe(boom);
    expect(received).toEqual([]);
  });

  it("never fires onExit more than once, even if close() runs after natural completion", async () => {
    const { queryFn, queries } = harness();
    const t = new ClaudeTransport({ cwd: "/tmp", canUseTool: noopCanUseTool, queryFn });
    let calls = 0;
    t.onExit(() => {
      calls++;
    });
    t.start();

    queries[0]!.finish();
    await flush();
    expect(calls).toBe(1);

    await t.close();
    expect(calls).toBe(1);
  });

  it("suppresses an exit listener that unsubscribed before exit", async () => {
    const { queryFn, queries } = harness();
    const t = new ClaudeTransport({ cwd: "/tmp", canUseTool: noopCanUseTool, queryFn });
    let called = false;
    const off = t.onExit(() => {
      called = true;
    });
    off();
    t.start();

    queries[0]!.finish();
    await flush();

    expect(called).toBe(false);
  });

  it("interrupt() calls the Query handle's interrupt() exactly once and resolves", async () => {
    const { queryFn, queries } = harness();
    const t = new ClaudeTransport({ cwd: "/tmp", canUseTool: noopCanUseTool, queryFn });
    t.start();

    await t.interrupt();

    expect(queries[0]?.interruptCalls).toBe(1);
  });

  it("interrupt() is a no-op (resolves, no throw) before start() and after exit", async () => {
    const { queryFn, queries } = harness();
    const t = new ClaudeTransport({ cwd: "/tmp", canUseTool: noopCanUseTool, queryFn });

    await expect(t.interrupt()).resolves.toBeUndefined(); // before start(): no query yet

    t.start();
    queries[0]!.finish();
    await flush();

    await expect(t.interrupt()).resolves.toBeUndefined(); // after exit
    expect(queries[0]?.interruptCalls).toBe(0);
  });

  it("close() ends the input stream and aborts via the abortController, and is idempotent", async () => {
    const { queryFn, calls } = harness();
    const t = new ClaudeTransport({ cwd: "/tmp", canUseTool: noopCanUseTool, queryFn });
    const exits: { error?: Error }[] = [];
    t.onExit((info) => exits.push(info));
    t.start();

    const abortController = calls[0]?.options.abortController as AbortController;
    const iterator = calls[0]!.prompt[Symbol.asyncIterator]();

    await t.close();

    expect(abortController.signal.aborted).toBe(true);
    await expect(iterator.next()).resolves.toEqual({ value: undefined, done: true });
    expect(exits).toEqual([{}]);

    await expect(t.close()).resolves.toBeUndefined(); // idempotent, no throw
    expect(exits).toEqual([{}]);
  });

  it("calls queryFn with settingSources:[], permissionMode 'default', cwd/model/resume, canUseTool, and an AbortController", () => {
    const { queryFn, calls } = harness();
    const t = new ClaudeTransport({
      cwd: "/repo",
      model: "claude-opus-4-8",
      resume: "sess-123",
      canUseTool: noopCanUseTool,
      queryFn,
    });
    t.start();

    const { options } = calls[0]!;
    expect(options.settingSources).toEqual([]);
    expect(options.permissionMode).toBe("default");
    expect(options.cwd).toBe("/repo");
    expect(options.model).toBe("claude-opus-4-8");
    expect(options.resume).toBe("sess-123");
    expect(options.canUseTool).toBe(noopCanUseTool);
    expect(options.abortController).toBeInstanceOf(AbortController);
  });
});
