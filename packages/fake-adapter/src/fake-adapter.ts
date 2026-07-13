import { randomUUID } from "node:crypto";
import {
  AgentEventSchema,
  canTransition,
  isDecisionValidForRequest,
  type AgentAdapter,
  type AgentEvent,
  type AgentKind,
  type ApprovalDecision,
  type ApprovalRequest,
  type InstallationStatus,
  type RecoverableSession,
  type ResumeSessionInput,
  type SessionHandle,
  type SessionStatus,
  type StartSessionInput,
  type UnsubscribeFunction,
} from "@agentdeck/shared";
import { PHASE_ONE, PHASE_TWO, type ScriptContext, type ScriptStep } from "./script.js";

export interface FakeAdapterOptions {
  /** Which vendor kind this fake pretends to be. Defaults to "claude". */
  kind?: AgentKind;
  /** Delay between scripted events, ms. Small default so streaming is observable but tests stay fast. */
  tickIntervalMs?: number;
  /** Override id generation for fully-deterministic assertions. Defaults to `crypto.randomUUID`. */
  idGenerator?: () => string;
  /** Override the clock. Defaults to real time (`new Date().toISOString()`). */
  now?: () => string;
}

interface SessionRuntime extends ScriptContext {
  status: SessionStatus;
  timer: ReturnType<typeof setTimeout> | undefined;
  pendingApproval: ApprovalRequest | undefined;
  pendingUserInput: { requestId: string } | undefined;
  ended: boolean;
}

/**
 * A deterministic `AgentAdapter` with no real agent process behind it — the fake session that
 * lets the rest of AgentDeck (server, UI) be exercised without a paid API call. See
 * `src/script.ts` for the exact scripted stream.
 *
 * Sequence numbers: every emitted event carries `sequence: 0`. Assigning the real monotonic
 * per-session sequence is `EventStore.appendEvent`'s job (`@agentdeck/event-store`) — the
 * adapter only knows event *order*, not the store's on-disk sequence, so it deliberately does
 * not guess one.
 */
export class FakeAdapter implements AgentAdapter {
  readonly kind: AgentKind;
  private readonly tickIntervalMs: number;
  private readonly idGenerator: () => string;
  private readonly now: () => string;
  private readonly sessions = new Map<string, SessionRuntime>();
  /**
   * Listeners, keyed by sessionId, independent of `sessions`/runtime lifecycle — so `subscribe`
   * can be called before `startSession` (the natural order: register a listener, then start,
   * so the caller can't race the first scripted event) without erroring.
   */
  private readonly listeners = new Map<string, Set<(event: AgentEvent) => void>>();

  constructor(options: FakeAdapterOptions = {}) {
    this.kind = options.kind ?? "claude";
    this.tickIntervalMs = options.tickIntervalMs ?? 5;
    this.idGenerator = options.idGenerator ?? randomUUID;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async detectInstallation(): Promise<InstallationStatus> {
    return { installed: true, version: "fake-adapter", authenticated: true };
  }

  async startSession(input: StartSessionInput): Promise<SessionHandle> {
    const externalSessionId = `fake-${input.sessionId}`;
    const runtime = this.register(input.sessionId, externalSessionId, input.workingDirectory);
    this.runQueue(runtime, [...PHASE_ONE]);
    return { sessionId: runtime.sessionId, externalSessionId };
  }

  async resumeSession(input: ResumeSessionInput): Promise<SessionHandle> {
    const runtime = this.register(input.sessionId, input.externalSessionId, input.workingDirectory);
    this.runQueue(runtime, [...PHASE_ONE]);
    return { sessionId: runtime.sessionId, externalSessionId: runtime.externalSessionId };
  }

  async sendMessage(sessionId: string, message: string): Promise<void> {
    const runtime = this.requireRuntime(sessionId);
    this.emit(runtime, () => ({ type: "user_message", source: "agentdeck", text: message }));
  }

  async approve(sessionId: string, decision: ApprovalDecision): Promise<void> {
    const runtime = this.requireRuntime(sessionId);
    const pending = runtime.pendingApproval;
    if (!pending) {
      throw new Error(`FakeAdapter: no pending approval for session ${sessionId}`);
    }
    if (!isDecisionValidForRequest(pending, decision)) {
      throw new Error(
        `FakeAdapter: optionId "${decision.optionId}" was not offered for request "${pending.requestId}"`,
      );
    }
    runtime.pendingApproval = undefined;
    this.runQueue(runtime, [...PHASE_TWO]);
  }

  async answerUserInput(sessionId: string, requestId: string, response: string): Promise<void> {
    const runtime = this.requireRuntime(sessionId);
    if (!runtime.pendingUserInput || runtime.pendingUserInput.requestId !== requestId) {
      throw new Error(`FakeAdapter: no pending user_input_requested "${requestId}" for session ${sessionId}`);
    }
    runtime.pendingUserInput = undefined;
    this.emit(runtime, () => ({ type: "user_message", source: "agentdeck", text: response }));
  }

  async interrupt(sessionId: string): Promise<void> {
    const runtime = this.requireRuntime(sessionId);
    this.clearTimer(runtime);
    this.tryTransition(runtime, "paused");
  }

  async stop(sessionId: string): Promise<void> {
    const runtime = this.requireRuntime(sessionId);
    this.clearTimer(runtime);
    this.tryTransition(runtime, "stopped");
    runtime.ended = true;
    this.listeners.delete(sessionId);
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
    const all = [...this.sessions.values()].map(
      (runtime): RecoverableSession => ({
        externalSessionId: runtime.externalSessionId,
        workingDirectory: runtime.workingDirectory,
        preview: "Fake session",
        updatedAt: this.now(),
      }),
    );
    return projectPath ? all.filter((r) => r.workingDirectory === projectPath) : all;
  }

  // ---- internals ----

  private register(sessionId: string, externalSessionId: string, workingDirectory: string): SessionRuntime {
    const runtime: SessionRuntime = {
      sessionId,
      externalSessionId,
      workingDirectory,
      kind: this.kind,
      status: "starting",
      timer: undefined,
      pendingApproval: undefined,
      pendingUserInput: undefined,
      ended: false,
    };
    this.sessions.set(sessionId, runtime);
    return runtime;
  }

  private requireRuntime(sessionId: string): SessionRuntime {
    const runtime = this.sessions.get(sessionId);
    if (!runtime) throw new Error(`FakeAdapter: unknown session ${sessionId}`);
    return runtime;
  }

  private clearTimer(runtime: SessionRuntime): void {
    if (runtime.timer !== undefined) {
      clearTimeout(runtime.timer);
      runtime.timer = undefined;
    }
  }

  /** Emit one scripted step. `session_status_changed` steps are checked against the state machine. */
  private emit(runtime: SessionRuntime, step: ScriptStep): AgentEvent {
    const partial = step(runtime);
    if (partial.type === "session_status_changed" && !canTransition(runtime.status, partial.status)) {
      // A script bug, not a caller error — fail loudly rather than silently corrupt state.
      throw new Error(`FakeAdapter script error: illegal transition ${runtime.status} -> ${partial.status}`);
    }
    const event = AgentEventSchema.parse({
      ...partial,
      id: this.idGenerator(),
      sessionId: runtime.sessionId,
      sequence: 0,
      timestamp: this.now(),
    });
    if (event.type === "session_status_changed") runtime.status = event.status;
    if (event.type === "approval_requested") runtime.pendingApproval = event.request;
    for (const listener of this.listeners.get(runtime.sessionId) ?? []) listener(event);
    return event;
  }

  /** Best-effort status transition used by interrupt/stop: a no-op if the jump isn't legal. */
  private tryTransition(runtime: SessionRuntime, next: SessionStatus): void {
    if (!canTransition(runtime.status, next)) return;
    const previous = runtime.status;
    this.emit(runtime, () => ({ type: "session_status_changed", source: "agentdeck", status: next, previous }));
  }

  /** Emit `queue` one event per tick; pauses (schedules nothing further) after `approval_requested`. */
  private runQueue(runtime: SessionRuntime, queue: ScriptStep[]): void {
    const tick = (): void => {
      if (runtime.ended) return;
      const step = queue.shift();
      if (!step) return;
      const event = this.emit(runtime, step);
      if (event.type === "approval_requested") return; // pause for approve()
      runtime.timer = setTimeout(tick, this.tickIntervalMs);
    };
    runtime.timer = setTimeout(tick, this.tickIntervalMs);
  }
}
