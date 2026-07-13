// Claude Agent SDK transport: wraps `query()` to drive a live Claude session in STREAMING INPUT
// MODE — `prompt` is an AsyncIterable<SDKUserMessage>, not a string — because the Query handle's
// control methods (interrupt, setPermissionMode) only work in that mode. Mirrors adapter-codex's
// CodexTransport shape (interface + injectable factory + listener sets + fire-once exit), but
// wraps an async generator instead of a child process: there is no separate "wire" to frame/parse,
// the SDKMessage stream itself IS the transport.
import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import type { SDKMessage, CanUseTool } from "@anthropic-ai/claude-agent-sdk";

export type MessageListener = (msg: SDKMessage) => void;
export type ExitListener = (info: { error?: Error }) => void;
export type Unsub = () => void;

export interface ClaudeQueryParams {
  prompt: AsyncIterable<unknown>;
  options: Record<string, unknown>;
}
/** DI seam: the real query() from the SDK, or a fake in tests. Returns an async generator of
 *  SDKMessage that also carries an async interrupt(). */
export type QueryFn = (params: ClaudeQueryParams) => AsyncGenerator<SDKMessage, void> & {
  interrupt?: () => Promise<unknown>;
};

export interface ClaudeTransportOptions {
  cwd: string;
  model?: string;
  /** externalSessionId to resume, when resuming. */
  resume?: string;
  /** The approval callback the SDK invokes; supplied by the adapter (bridges to the approval bridge). */
  canUseTool: CanUseTool;
  /** DI: defaults to the SDK's real `query`. */
  queryFn?: QueryFn;
}

export interface ClaudeTransportLike {
  /** Begin the query and start consuming its message stream. Idempotent-safe to call once. */
  start(): void;
  /** Push a user message onto the streaming-input queue (a new turn / follow-up). */
  send(text: string): void;
  /** Interrupt the in-flight turn (calls the Query handle's interrupt()). No-op if not started. */
  interrupt(): Promise<void>;
  /** End the input stream and abort the query. Idempotent. */
  close(): Promise<void>;
  onMessage(listener: MessageListener): Unsub;
  onExit(listener: ExitListener): Unsub;
}

const defaultQueryFn: QueryFn = (params) =>
  sdkQuery(params as Parameters<typeof sdkQuery>[0]) as ReturnType<QueryFn>;

/** A push-based AsyncIterable that backs the streaming-input `prompt`: `send()` pushes items,
 *  `end()` completes it (mirrors an async channel — no buffering surprises for a single consumer). */
class PushQueue<T> implements AsyncIterable<T> {
  private readonly buffer: T[] = [];
  private waiting: ((r: IteratorResult<T, void>) => void) | null = null;
  private ended = false;

  push(item: T): void {
    if (this.ended) return;
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve({ value: item, done: false });
    } else {
      this.buffer.push(item);
    }
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T, void> {
    return {
      next: (): Promise<IteratorResult<T, void>> => {
        if (this.buffer.length > 0) {
          return Promise.resolve({ value: this.buffer.shift() as T, done: false });
        }
        if (this.ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => {
          this.waiting = resolve;
        });
      },
    };
  }
}

export class ClaudeTransport implements ClaudeTransportLike {
  private readonly messageListeners = new Set<MessageListener>();
  private readonly exitListeners = new Set<ExitListener>();
  private readonly input = new PushQueue<unknown>();
  private readonly abortController = new AbortController();
  private query: ReturnType<QueryFn> | null = null;
  private started = false;
  private exited = false;

  constructor(private readonly opts: ClaudeTransportOptions) {}

  start(): void {
    if (this.started) return;
    this.started = true;

    const options: Record<string, unknown> = {
      cwd: this.opts.cwd,
      settingSources: [],
      permissionMode: "default",
      canUseTool: this.opts.canUseTool,
      abortController: this.abortController,
    };
    if (this.opts.model !== undefined) options.model = this.opts.model;
    if (this.opts.resume !== undefined) options.resume = this.opts.resume;

    const queryFn = this.opts.queryFn ?? defaultQueryFn;
    this.query = queryFn({ prompt: this.input, options });
    void this.consume();
  }

  send(text: string): void {
    this.input.push({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null });
  }

  async interrupt(): Promise<void> {
    if (!this.query || this.exited) return;
    await this.query.interrupt?.();
  }

  async close(): Promise<void> {
    this.input.end();
    this.abortController.abort();
    this.finish({});
  }

  onMessage(listener: MessageListener): Unsub {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  onExit(listener: ExitListener): Unsub {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  // ---- internals ----

  private async consume(): Promise<void> {
    if (!this.query) return;
    try {
      for await (const msg of this.query) {
        for (const l of this.messageListeners) l(msg);
      }
      this.finish({});
    } catch (err) {
      this.finish({ error: err instanceof Error ? err : new Error(String(err)) });
    }
  }

  /** Single termination path — fires exit listeners once, whether reached via natural completion,
   *  a thrown error, or an explicit close(). */
  private finish(info: { error?: Error }): void {
    if (this.exited) return;
    this.exited = true;
    for (const l of this.exitListeners) l(info);
  }
}
