// Codex app-server stdio transport.
// Encapsulates: spawning `codex app-server`, NDJSON framing, request/response correlation,
// notification fan-out, and server-initiated request handling (approvals). Lifted from
// spikes/codex-app-server/src/transport.ts (live-verified in Phase 0) with two Phase-2 additions
// required by the adapter (design §8.5):
//   1. an `onExit` hook so the adapter can fail held approvals + mark the session failed on crash;
//   2. `writeLine` guards on `closed` so a late resolve after termination doesn't hit a dead pipe.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { LineBuffer, classify } from "./framing.js";
import type {
  RequestId,
  WireResponse,
  WireServerNotification,
  WireServerRequest,
} from "./proto.js";

export type NotificationListener = (n: WireServerNotification) => void;
/** Return the `result` payload to answer a server request; throw to answer with an error.
 *  May return a Promise that stays pending — the transport holds the response open until it
 *  settles (this is how AgentDeck defers an approval to the phone; see approvals-bridge). */
export type ServerRequestHandler = (r: WireServerRequest) => Promise<unknown> | unknown;
export type RawLogger = (dir: "recv" | "send", line: string) => void;
/** Fired once when the child process terminates (crash, exit, or spawn failure). NOT fired for a
 *  reason the adapter already knows about if it unsubscribes before calling `close()`. */
export type ExitInfo = { code: number | null; signal: NodeJS.Signals | null; error?: Error };
export type ExitListener = (info: ExitInfo) => void;

export interface CodexTransportOptions {
  command?: string; // default "codex"
  args?: string[]; // default ["app-server"]
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  onRawLine?: RawLogger; // receives EVERY line both directions (redact before persisting)
}

/** The subset the adapter/session programs against — lets tests inject a fake transport with no
 *  real process (design §9). `CodexTransport` implements it. */
export interface TransportLike {
  start(): Promise<void>;
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
  notify(method: string, params?: unknown): void;
  onNotification(listener: NotificationListener): () => void;
  setServerRequestHandler(handler: ServerRequestHandler): void;
  onExit(listener: ExitListener): () => void;
  close(): Promise<void>;
}

interface Pending {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  method: string;
}

export class CodexTransport implements TransportLike {
  private child: ChildProcessWithoutNullStreams | null = null;
  private readonly lineBuf = new LineBuffer();
  private readonly pending = new Map<RequestId, Pending>();
  private readonly notificationListeners = new Set<NotificationListener>();
  private readonly exitListeners = new Set<ExitListener>();
  private serverRequestHandler: ServerRequestHandler | null = null;
  private nextId = 1; // our client id space; the server uses its OWN space (seen starting at 0)
  private closed = false;
  private terminated = false; // guards onExit/failAll from firing twice

  constructor(private readonly opts: CodexTransportOptions = {}) {}

  async start(): Promise<void> {
    const command = this.opts.command ?? "codex";
    const args = this.opts.args ?? ["app-server"];
    const child = spawn(command, args, {
      cwd: this.opts.cwd,
      env: this.opts.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.onStdout(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => this.opts.onRawLine?.("recv", `[stderr] ${chunk}`));
    child.on("exit", (code, signal) => this.onExitInternal(code, signal));
    child.on("error", (err) =>
      this.terminate({ code: null, signal: null, error: new Error(`app-server spawn error: ${err.message}`) }),
    );
  }

  /** Send a request and await its correlated response. */
  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (!this.child || this.closed) return Promise.reject(new Error("transport not running"));
    const id = this.nextId++;
    const line = JSON.stringify({ id, method, params }) + "\n";
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (r: unknown) => void, reject, method });
      this.writeLine(line);
    });
  }

  /** Fire a client notification (no response expected). */
  notify(method: string, params?: unknown): void {
    if (!this.child || this.closed) return;
    this.writeLine(JSON.stringify(params === undefined ? { method } : { method, params }) + "\n");
  }

  /** Reply to a server-initiated request with a result. */
  private respond(id: RequestId, result: unknown): void {
    this.writeLine(JSON.stringify({ id, result }) + "\n");
  }
  /** Reply to a server-initiated request with an error. */
  private respondError(id: RequestId, message: string): void {
    this.writeLine(JSON.stringify({ id, error: { message } }) + "\n");
  }

  onNotification(listener: NotificationListener): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  /** Register a process-termination listener. The adapter unsubscribes before its own `close()`
   *  so a graceful stop is not mistaken for a crash. */
  onExit(listener: ExitListener): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  setServerRequestHandler(handler: ServerRequestHandler): void {
    this.serverRequestHandler = handler;
  }

  async close(): Promise<void> {
    this.closed = true;
    const child = this.child;
    if (!child) return;
    try {
      child.stdin.end();
    } catch {
      /* ignore */
    }
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 1000);
      child.once("exit", () => {
        clearTimeout(t);
        resolve();
      });
    });
  }

  // ---- internals ----

  private writeLine(line: string): void {
    if (this.closed || this.terminated) return; // never write to a closing/dead pipe
    this.opts.onRawLine?.("send", line.replace(/\n$/, ""));
    this.child?.stdin.write(line);
  }

  private onStdout(chunk: string): void {
    for (const line of this.lineBuf.push(chunk)) {
      this.opts.onRawLine?.("recv", line);
      let msg: unknown;
      try {
        msg = JSON.parse(line);
      } catch {
        // Unknown/non-JSON output: preserve as raw, never guess. (Plan: unknown => raw.)
        continue;
      }
      this.route(msg);
    }
  }

  private route(msg: unknown): void {
    switch (classify(msg)) {
      case "response": {
        const r = msg as WireResponse;
        const p = this.pending.get(r.id);
        if (!p) return; // late/duplicate response — ignore
        this.pending.delete(r.id);
        if (r.error) p.reject(new Error(r.error.message ?? `error in ${p.method}`));
        else p.resolve(r.result);
        return;
      }
      case "serverRequest": {
        void this.handleServerRequest(msg as WireServerRequest);
        return;
      }
      case "notification": {
        const n = msg as WireServerNotification;
        for (const l of this.notificationListeners) l(n);
        return;
      }
      default:
        return; // unknown shape: ignore
    }
  }

  private async handleServerRequest(req: WireServerRequest): Promise<void> {
    if (!this.serverRequestHandler) {
      // No handler wired — decline rather than hang the agent's turn.
      this.respondError(req.id, "no server-request handler registered");
      return;
    }
    try {
      const result = await this.serverRequestHandler(req);
      this.respond(req.id, result);
    } catch (err) {
      this.respondError(req.id, err instanceof Error ? err.message : String(err));
    }
  }

  private onExitInternal(code: number | null, signal: NodeJS.Signals | null): void {
    this.opts.onRawLine?.("recv", `[exit] code=${code} signal=${signal}`);
    this.terminate({ code, signal });
  }

  /** Single termination path — fires exit listeners once, then rejects every in-flight request. */
  private terminate(info: ExitInfo): void {
    if (this.terminated) return;
    this.terminated = true;
    this.closed = true;
    for (const l of this.exitListeners) l(info);
    const reason =
      info.error ?? new Error(`app-server exited (code=${info.code}, signal=${info.signal})`);
    this.failAll(reason);
  }

  private failAll(err: Error): void {
    for (const [, p] of this.pending) p.reject(err);
    this.pending.clear();
  }
}
