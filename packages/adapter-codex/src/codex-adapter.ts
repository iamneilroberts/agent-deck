// The one class the server programs against (design §3): assembles CodexTransport + CodexMapper +
// CodexApprovalBridge behind the vendor-neutral AgentAdapter interface. A faithful transport —
// maps the Codex v2 thread/turn stream into normalized AgentEvents, defers approvals to the phone,
// and routes status through the state machine.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  AgentEventSchema,
  canTransition,
  type AgentAdapter,
  type AgentEvent,
  type AgentKind,
  type ApprovalDecision,
  type InstallationStatus,
  type RecoverableSession,
  type ResumeSessionInput,
  type SessionHandle,
  type SessionStatus,
  type StartSessionInput,
  type UnsubscribeFunction,
} from "@agentdeck/shared";
import { CodexTransport, type CodexTransportOptions, type ExitInfo, type TransportLike } from "./transport.js";
import { CodexMapper, type CodexEventDraft } from "./mapping.js";
import { CodexApprovalBridge } from "./approvals-bridge.js";
import { textInput, type ThreadStartResult, type WireServerNotification } from "./proto.js";

export interface CodexAdapterOptions {
  /** Codex binary name/path. Default "codex". */
  command?: string;
  /** Inject a transport (default `new CodexTransport(...)`) — lets tests drive with no process. */
  transportFactory?: (opts: CodexTransportOptions) => TransportLike;
  /** Override event id generation for deterministic tests. Default `crypto.randomUUID`. */
  idGenerator?: () => string;
  /** Override the clock. Default real time. */
  now?: () => string;
}

interface SessionRuntime {
  sessionId: string;
  externalSessionId: string | undefined;
  workingDirectory: string;
  transport: TransportLike;
  mapper: CodexMapper;
  bridge: CodexApprovalBridge;
  status: SessionStatus;
  offExit: UnsubscribeFunction | undefined;
  ended: boolean;
}

export class CodexAdapter implements AgentAdapter {
  readonly kind: AgentKind = "codex";

  private readonly command: string;
  private readonly transportFactory: (opts: CodexTransportOptions) => TransportLike;
  private readonly idGenerator: () => string;
  private readonly now: () => string;
  private readonly sessions = new Map<string, SessionRuntime>();
  /** Listeners keyed by sessionId, independent of runtime lifecycle so `subscribe` can be called
   *  before `startSession` (the server's order) — mirrors FakeAdapter. */
  private readonly listeners = new Map<string, Set<(event: AgentEvent) => void>>();

  constructor(options: CodexAdapterOptions = {}) {
    this.command = options.command ?? "codex";
    this.transportFactory = options.transportFactory ?? ((opts) => new CodexTransport(opts));
    this.idGenerator = options.idGenerator ?? randomUUID;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async detectInstallation(): Promise<InstallationStatus> {
    return new Promise<InstallationStatus>((resolve) => {
      execFile(this.command, ["--version"], { timeout: 5000 }, (err, stdout) => {
        if (err) {
          resolve({ installed: false, detail: err.message });
          return;
        }
        resolve({ installed: true, version: stdout.trim() });
      });
    });
  }

  async startSession(input: StartSessionInput): Promise<SessionHandle> {
    const runtime = this.spawn(input.sessionId, input.workingDirectory);
    await runtime.transport.start();
    await this.initialize(runtime);
    const started = await runtime.transport.request<ThreadStartResult>("thread/start", {
      cwd: input.workingDirectory,
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      model: input.model ?? null,
    });
    const threadId = started.thread.id;
    runtime.externalSessionId = threadId;
    this.emit(runtime, { type: "session_started", source: "codex", externalSessionId: threadId, model: started.model });
    if (input.prompt) await this.startTurn(runtime, input.prompt);
    return { sessionId: input.sessionId, externalSessionId: threadId };
  }

  async resumeSession(input: ResumeSessionInput): Promise<SessionHandle> {
    const runtime = this.spawn(input.sessionId, input.workingDirectory);
    runtime.externalSessionId = input.externalSessionId;
    await runtime.transport.start();
    await this.initialize(runtime);
    await runtime.transport.request("thread/resume", {
      threadId: input.externalSessionId,
      cwd: input.workingDirectory,
    });
    this.emit(runtime, { type: "session_started", source: "codex", externalSessionId: input.externalSessionId });
    if (input.prompt) await this.startTurn(runtime, input.prompt);
    return { sessionId: input.sessionId, externalSessionId: input.externalSessionId };
  }

  /** A follow-up user turn. Deliberately emits NO user_message — Codex echoes it as a userMessage
   *  item, which the mapper turns into the single user_message event (avoids a duplicate). */
  async sendMessage(sessionId: string, message: string): Promise<void> {
    const runtime = this.require(sessionId);
    await this.startTurn(runtime, message);
  }

  async approve(sessionId: string, decision: ApprovalDecision): Promise<void> {
    const runtime = this.require(sessionId);
    // Leave waiting_for_approval before answering; the resumed turn drives status onward.
    this.emit(runtime, { type: "session_status_changed", source: "agentdeck", status: "running" });
    runtime.bridge.resolveApproval(decision.requestId, decision.optionId, decision.note);
  }

  async answerUserInput(sessionId: string, requestId: string, response: string): Promise<void> {
    const runtime = this.require(sessionId);
    this.emit(runtime, { type: "session_status_changed", source: "agentdeck", status: "running" });
    runtime.bridge.resolveUserInput(requestId, response);
  }

  async interrupt(sessionId: string): Promise<void> {
    const runtime = this.require(sessionId);
    const turnId = runtime.mapper.turnId;
    if (!turnId || !runtime.externalSessionId) return; // no turn in flight (see §3 race note)
    await runtime.transport.request("turn/interrupt", { threadId: runtime.externalSessionId, turnId });
    // The resulting turn/completed(status:"interrupted") maps to `paused` via the mapper.
  }

  async stop(sessionId: string): Promise<void> {
    const runtime = this.require(sessionId);
    runtime.offExit?.(); // graceful close must not be mistaken for a crash
    runtime.ended = true;
    this.emit(runtime, { type: "session_status_changed", source: "agentdeck", status: "stopped" });
    runtime.bridge.rejectAll(new Error("session stopped"));
    await runtime.transport.close();
    this.listeners.delete(sessionId);
    this.sessions.delete(sessionId);
  }

  subscribe(sessionId: string, listener: (event: AgentEvent) => void): UnsubscribeFunction {
    let set = this.listeners.get(sessionId);
    if (!set) {
      set = new Set();
      this.listeners.set(sessionId, set);
    }
    set.add(listener);
    return () => set.delete(listener);
  }

  async listRecoverableSessions(projectPath?: string): Promise<RecoverableSession[]> {
    const transport = this.transportFactory({ command: this.command, args: ["app-server"] });
    try {
      await transport.start();
      await transport.request("initialize", this.initializeParams());
      transport.notify("initialized");
      const res = await transport.request<{ data?: Array<{ id: string; cwd: string; preview?: string }> }>(
        "thread/list",
        projectPath ? { cwd: projectPath } : {},
      );
      return (res.data ?? []).map((t) => ({
        externalSessionId: t.id,
        workingDirectory: t.cwd,
        preview: t.preview,
      }));
    } finally {
      await transport.close();
    }
  }

  // ---- internals ----

  /** Create the runtime + transport and wire notification/approval/exit handlers BEFORE start, so
   *  the first async notification can't slip past (design §3 no-loss). */
  private spawn(sessionId: string, workingDirectory: string): SessionRuntime {
    const transport = this.transportFactory({ command: this.command, args: ["app-server"], cwd: workingDirectory });
    const runtime: SessionRuntime = {
      sessionId,
      externalSessionId: undefined,
      workingDirectory,
      transport,
      mapper: new CodexMapper(),
      bridge: new CodexApprovalBridge(),
      status: "starting",
      offExit: undefined,
      ended: false,
    };
    this.sessions.set(sessionId, runtime);

    transport.onNotification((n) => this.onNotification(runtime, n));
    transport.setServerRequestHandler((req) => runtime.bridge.onServerRequest(req, (draft) => this.emitFromBridge(runtime, draft)));
    runtime.offExit = transport.onExit((info) => this.onExit(runtime, info));
    return runtime;
  }

  private async initialize(runtime: SessionRuntime): Promise<void> {
    await runtime.transport.request("initialize", this.initializeParams());
    runtime.transport.notify("initialized");
  }

  private initializeParams(): unknown {
    return {
      clientInfo: { name: "agentdeck", title: "AgentDeck", version: "0.0.0" },
      capabilities: { experimentalApi: true, requestAttestation: false },
    };
  }

  private async startTurn(runtime: SessionRuntime, text: string): Promise<void> {
    if (!runtime.externalSessionId) throw new Error(`session ${runtime.sessionId} has no thread id`);
    await runtime.transport.request("turn/start", { threadId: runtime.externalSessionId, input: textInput(text) });
  }

  private onNotification(runtime: SessionRuntime, n: WireServerNotification): void {
    for (const draft of runtime.mapper.map(n)) this.emit(runtime, draft);
  }

  /** Approvals/user-input imply a status transition emitted BEFORE the content event, so the phone
   *  sees the session enter `waiting_*` alongside the prompt. */
  private emitFromBridge(runtime: SessionRuntime, draft: CodexEventDraft): void {
    if (draft.type === "approval_requested") {
      this.emit(runtime, { type: "session_status_changed", source: "agentdeck", status: "waiting_for_approval" });
    } else if (draft.type === "user_input_requested") {
      this.emit(runtime, { type: "session_status_changed", source: "agentdeck", status: "waiting_for_user" });
    }
    this.emit(runtime, draft);
  }

  /** Crash path (design §8.5): reject held approvals, surface an error, mark the session failed. */
  private onExit(runtime: SessionRuntime, info: ExitInfo): void {
    if (runtime.ended) return;
    runtime.ended = true;
    runtime.bridge.rejectAll(new Error("codex app-server exited"));
    this.emit(runtime, {
      type: "error",
      source: "codex",
      message: info.error?.message ?? `codex app-server exited (code=${info.code}, signal=${info.signal})`,
      recoverable: false,
    });
    this.emit(runtime, { type: "session_status_changed", source: "agentdeck", status: "failed" });
  }

  /**
   * Stamp the envelope, validate, and fan out. Status drafts are COALESCED against the live status
   * (skip a no-op or an illegal jump instead of throwing — design §6), so a status intent that
   * races the live state degrades to nothing rather than corrupting it.
   */
  private emit(runtime: SessionRuntime, draft: CodexEventDraft): void {
    let d = draft;
    if (d.type === "session_status_changed") {
      if (d.status === runtime.status) return; // no-op
      if (!canTransition(runtime.status, d.status)) return; // illegal from here: coalesce away
      d = { ...d, previous: runtime.status };
    }
    const event = AgentEventSchema.parse({
      ...d,
      id: this.idGenerator(),
      sessionId: runtime.sessionId,
      sequence: 0,
      timestamp: this.now(),
    });
    if (event.type === "session_status_changed") runtime.status = event.status;
    for (const listener of this.listeners.get(runtime.sessionId) ?? []) listener(event);
  }

  private require(sessionId: string): SessionRuntime {
    const runtime = this.sessions.get(sessionId);
    if (!runtime) throw new Error(`CodexAdapter: unknown session ${sessionId}`);
    return runtime;
  }
}
