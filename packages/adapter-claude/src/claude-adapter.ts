// The one class the server programs against for Claude (ADR-0001): assembles ClaudeTransport +
// ClaudeMapper + ClaudeApprovalBridge behind the vendor-neutral AgentAdapter interface. Mirrors
// CodexAdapter. Differences that come from the Agent SDK rather than a thread/turn wire protocol:
//   - No initialize/thread-start handshake: startSession just begins the query and pushes the
//     first user message. The vendor session id arrives ASYNC in the first `system/init`
//     (surfaced via the mapper's session_started event), per SessionHandle's contract.
//   - The SDK does NOT echo the pushed user prompt as a `user` message, so the adapter emits the
//     `user_message` event itself (Codex relied on the echo).
//   - Approvals ride the SDK's `canUseTool` callback (control protocol), not a wire request.
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
import type { CanUseTool, PermissionResult, PermissionUpdate } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeTransport, type ClaudeTransportLike, type ClaudeTransportOptions } from "./transport.js";
import { ClaudeMapper, type ClaudeEventDraft } from "./mapping.js";
import { ClaudeApprovalBridge } from "./approvals-bridge.js";

export interface ClaudeAdapterOptions {
  /** Claude binary name/path (for detectInstallation). Default "claude". */
  command?: string;
  /** Inject a transport (default `new ClaudeTransport(...)`) — lets tests drive with no SDK/process. */
  transportFactory?: (opts: ClaudeTransportOptions) => ClaudeTransportLike;
  /** Override event id generation for deterministic tests. Default `crypto.randomUUID`. */
  idGenerator?: () => string;
  /** Override the clock. Default real time. */
  now?: () => string;
}

interface SessionRuntime {
  sessionId: string;
  externalSessionId: string | undefined;
  workingDirectory: string;
  transport: ClaudeTransportLike;
  mapper: ClaudeMapper;
  bridge: ClaudeApprovalBridge;
  status: SessionStatus;
  offExit: UnsubscribeFunction | undefined;
  ended: boolean;
}

export class ClaudeAdapter implements AgentAdapter {
  readonly kind: AgentKind = "claude";

  private readonly command: string;
  private readonly transportFactory: (opts: ClaudeTransportOptions) => ClaudeTransportLike;
  private readonly idGenerator: () => string;
  private readonly now: () => string;
  private readonly sessions = new Map<string, SessionRuntime>();
  /** Listeners keyed by sessionId, independent of runtime lifecycle so `subscribe` can be called
   *  before `startSession` (the server's order) — mirrors CodexAdapter/FakeAdapter. */
  private readonly listeners = new Map<string, Set<(event: AgentEvent) => void>>();

  constructor(options: ClaudeAdapterOptions = {}) {
    this.command = options.command ?? "claude";
    this.transportFactory = options.transportFactory ?? ((opts) => new ClaudeTransport(opts));
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
    const runtime = this.spawn(input.sessionId, input.workingDirectory, { model: input.model });
    runtime.transport.start();
    // The vendor session id arrives async in the first `system/init` (mapper -> session_started).
    if (input.prompt) this.sendTurn(runtime, input.prompt);
    return { sessionId: input.sessionId, externalSessionId: undefined };
  }

  async resumeSession(input: ResumeSessionInput): Promise<SessionHandle> {
    const runtime = this.spawn(input.sessionId, input.workingDirectory, {
      model: undefined,
      resume: input.externalSessionId,
    });
    runtime.externalSessionId = input.externalSessionId;
    runtime.transport.start();
    if (input.prompt) this.sendTurn(runtime, input.prompt);
    return { sessionId: input.sessionId, externalSessionId: input.externalSessionId };
  }

  /** A follow-up user turn. Unlike Codex, the SDK does not echo the prompt, so we emit the
   *  user_message ourselves. */
  async sendMessage(sessionId: string, message: string): Promise<void> {
    const runtime = this.require(sessionId);
    this.sendTurn(runtime, message);
  }

  async approve(sessionId: string, decision: ApprovalDecision): Promise<void> {
    const runtime = this.require(sessionId);
    // Leave waiting_for_approval before answering; the resumed turn drives status onward. Required:
    // completed/failed can't be reached directly from waiting_for_approval, so we MUST return to
    // running first or the eventual result would be coalesced away.
    this.emit(runtime, { type: "session_status_changed", source: "agentdeck", status: "running" });
    runtime.bridge.resolve(decision);
  }

  /** Claude has no requestUserInput surface in this phase — questions arrive as tool calls and ride
   *  the approval path. Kept explicit so a mis-routed call fails loudly rather than silently. */
  async answerUserInput(sessionId: string, _requestId: string, _response: string): Promise<void> {
    this.require(sessionId);
    throw new Error("ClaudeAdapter: user-input answering is not supported (Claude surfaces questions as tool approvals)");
  }

  async interrupt(sessionId: string): Promise<void> {
    const runtime = this.require(sessionId);
    await runtime.transport.interrupt();
    // If a turn is in flight this pauses it; if the turn already settled, `running -> paused` is
    // illegal and the emit is coalesced away (faithful — we don't fabricate a pause).
    this.emit(runtime, { type: "session_status_changed", source: "agentdeck", status: "paused" });
  }

  async stop(sessionId: string): Promise<void> {
    const runtime = this.require(sessionId);
    runtime.offExit?.(); // graceful close must not be mistaken for a crash
    runtime.ended = true;
    this.emit(runtime, { type: "session_status_changed", source: "agentdeck", status: "stopped" });
    runtime.bridge.cancelAll("session stopped");
    await runtime.transport.close();
    this.listeners.delete(sessionId);
    this.sessions.delete(sessionId);
  }

  async shutdown(): Promise<void> {
    for (const [sessionId, runtime] of [...this.sessions]) {
      if (!runtime.ended) await this.stop(sessionId);
    }
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
    try {
      const { listSessions } = await import("@anthropic-ai/claude-agent-sdk");
      const sessions = await listSessions(projectPath ? { dir: projectPath } : undefined);
      return sessions.map((s) => ({
        externalSessionId: s.sessionId,
        workingDirectory: s.cwd ?? projectPath ?? "",
        preview: s.customTitle ?? s.summary ?? s.firstPrompt,
        updatedAt: s.lastModified ? new Date(s.lastModified).toISOString() : undefined,
      }));
    } catch {
      // Session history is best-effort; never let a listing failure break the caller.
      return [];
    }
  }

  // ---- internals ----

  /** Create the runtime + transport and wire message/approval/exit handlers. `canUseTool` bridges
   *  the SDK's approval callback to the neutral approval bridge. */
  private spawn(sessionId: string, workingDirectory: string, opts: { model?: string; resume?: string }): SessionRuntime {
    const mapper = new ClaudeMapper();
    const bridge = new ClaudeApprovalBridge();
    const runtimeRef = { current: undefined as SessionRuntime | undefined };
    const canUseTool: CanUseTool = (toolName, input, options): Promise<PermissionResult> => {
      const runtime = runtimeRef.current!;
      const suggestions = (options as { suggestions?: PermissionUpdate[] } | undefined)?.suggestions;
      return runtime.bridge.request(toolName, input, { suggestions }, (draft) => this.emitFromBridge(runtime, draft));
    };
    const transport = this.transportFactory({
      cwd: workingDirectory,
      model: opts.model,
      resume: opts.resume,
      canUseTool,
    });
    const runtime: SessionRuntime = {
      sessionId,
      externalSessionId: undefined,
      workingDirectory,
      transport,
      mapper,
      bridge,
      status: "starting",
      offExit: undefined,
      ended: false,
    };
    runtimeRef.current = runtime;
    this.sessions.set(sessionId, runtime);

    transport.onMessage((msg) => this.onMessage(runtime, msg));
    runtime.offExit = transport.onExit((info) => this.onExit(runtime, info));
    return runtime;
  }

  private sendTurn(runtime: SessionRuntime, text: string): void {
    runtime.transport.send(text);
    this.emit(runtime, { type: "user_message", source: "agentdeck", text });
  }

  private onMessage(runtime: SessionRuntime, msg: unknown): void {
    for (const draft of runtime.mapper.map(msg as never)) {
      if (draft.type === "session_started" && draft.externalSessionId) {
        runtime.externalSessionId = draft.externalSessionId;
      }
      this.emit(runtime, draft);
    }
  }

  /** An approval implies a status transition emitted BEFORE the request event, so the phone sees the
   *  session enter `waiting_for_approval` alongside the prompt. */
  private emitFromBridge(runtime: SessionRuntime, draft: ClaudeEventDraft): void {
    if (draft.type === "approval_requested") {
      this.emit(runtime, { type: "session_status_changed", source: "agentdeck", status: "waiting_for_approval" });
    }
    this.emit(runtime, draft);
  }

  /** Crash path: deny held approvals, surface an error, mark the session failed. */
  private onExit(runtime: SessionRuntime, info: { error?: Error }): void {
    if (runtime.ended) return;
    runtime.ended = true;
    runtime.bridge.cancelAll("claude session exited");
    this.emit(runtime, {
      type: "error",
      source: "claude",
      message: info.error?.message ?? "claude session exited unexpectedly",
      recoverable: false,
    });
    this.emit(runtime, { type: "session_status_changed", source: "agentdeck", status: "failed" });
  }

  /**
   * Stamp the envelope, validate, and fan out. Status drafts are COALESCED against the live status
   * (skip a no-op or an illegal jump instead of throwing), so a status intent that races the live
   * state degrades to nothing rather than corrupting it.
   */
  private emit(runtime: SessionRuntime, draft: ClaudeEventDraft): void {
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
    if (!runtime) throw new Error(`ClaudeAdapter: unknown session ${sessionId}`);
    return runtime;
  }
}
