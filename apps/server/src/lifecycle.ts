// The session lifecycle wiring: adapter events -> EventStore (assigns sequence) -> WS hub.
// Persist-then-broadcast is load-bearing (see docs/api-contract.md) — a reconnecting client
// must always be able to recover the full history from the store, so nothing is published to
// the hub before `store.appendEvent` returns.
import type { EventStore } from "@agentdeck/event-store";
import {
  InvalidTransitionError,
  isDecisionValidForRequest,
  type AgentAdapter,
  type AgentEvent,
  type AgentKind,
  type AgentSession,
  type ApprovalDecision,
  type ApprovalRequest,
} from "@agentdeck/shared";
import type { AdapterRegistry } from "./types.js";
import { SessionEventHub } from "./hub.js";
import {
  AdapterNotRegisteredError,
  InvalidApprovalError,
  InvalidUserInputResponseError,
  SessionNotResumableError,
  UnknownSessionError,
} from "./errors.js";

export interface CreateSessionParams {
  projectId: string;
  agentKind: AgentKind;
  workingDirectory: string;
  prompt?: string;
  model?: string;
}

interface PendingUserInput {
  readonly requestId: string;
  readonly prompt: string;
}

export interface LifecycleLogger {
  error(obj: Record<string, unknown>, msg: string): void;
}

export class Lifecycle {
  readonly hub = new SessionEventHub();

  /** Adapter-reported vendor session id, keyed by our sessionId (see README: EventStore has
   *  no generic session-update method beyond status, so this is tracked server-side). */
  private readonly externalSessionIds = new Map<string, string>();
  private readonly pendingApprovals = new Map<string, ApprovalRequest>();
  private readonly pendingUserInputs = new Map<string, PendingUserInput>();

  constructor(
    private readonly store: EventStore,
    private readonly adapters: AdapterRegistry,
    private readonly logger: LifecycleLogger,
  ) {}

  adapterFor(kind: AgentKind): AgentAdapter {
    const adapter = this.adapters.get(kind);
    if (!adapter) throw new AdapterNotRegisteredError(kind);
    return adapter;
  }

  requireSession(sessionId: string): AgentSession {
    const session = this.store.getSession(sessionId);
    if (!session) throw new UnknownSessionError(sessionId);
    return session;
  }

  async createSession(params: CreateSessionParams): Promise<AgentSession> {
    const adapter = this.adapterFor(params.agentKind);
    const session = this.store.createSession({
      projectId: params.projectId,
      agentKind: params.agentKind,
      workingDirectory: params.workingDirectory,
      status: "starting",
    });
    adapter.subscribe(session.id, (event) => this.handleAdapterEvent(session.id, event));
    await adapter.startSession({
      sessionId: session.id,
      workingDirectory: params.workingDirectory,
      prompt: params.prompt,
      model: params.model,
    });
    return session;
  }

  async sendMessage(sessionId: string, text: string): Promise<void> {
    const session = this.requireSession(sessionId);
    await this.adapterFor(session.agentKind).sendMessage(sessionId, text);
  }

  async interrupt(sessionId: string): Promise<void> {
    const session = this.requireSession(sessionId);
    await this.adapterFor(session.agentKind).interrupt(sessionId);
  }

  async stop(sessionId: string): Promise<void> {
    const session = this.requireSession(sessionId);
    await this.adapterFor(session.agentKind).stop(sessionId);
  }

  /** `stopped` is terminal — resuming a stopped session means starting a new one (see errors.ts). */
  async resume(sessionId: string): Promise<AgentSession> {
    const session = this.requireSession(sessionId);
    if (session.status === "stopped") throw new SessionNotResumableError(sessionId);
    const adapter = this.adapterFor(session.agentKind);
    const externalSessionId =
      this.externalSessionIds.get(sessionId) ?? session.externalSessionId ?? `unknown-${sessionId}`;
    await adapter.resumeSession({
      sessionId,
      externalSessionId,
      workingDirectory: session.workingDirectory,
    });
    return this.requireSession(sessionId);
  }

  /** Validates against the pending `ApprovalRequest` before touching the adapter — an
   *  un-offered optionId (or a request the session has no pending approval for) throws
   *  `InvalidApprovalError`, which the route layer turns into a 400. */
  async resolveApproval(
    sessionId: string,
    requestId: string,
    optionId: string,
    note?: string,
    updatedInput?: unknown,
  ): Promise<void> {
    const session = this.requireSession(sessionId);
    const pending = this.pendingApprovals.get(sessionId);
    const decision: ApprovalDecision = { requestId, optionId, note, updatedInput };
    if (!pending || !isDecisionValidForRequest(pending, decision)) {
      throw new InvalidApprovalError(sessionId, requestId, optionId);
    }
    this.pendingApprovals.delete(sessionId);
    await this.adapterFor(session.agentKind).approve(sessionId, decision);
  }

  async respondToInputRequest(sessionId: string, requestId: string, response: string): Promise<void> {
    const session = this.requireSession(sessionId);
    const pending = this.pendingUserInputs.get(sessionId);
    if (!pending || pending.requestId !== requestId) {
      throw new InvalidUserInputResponseError(sessionId, requestId);
    }
    this.pendingUserInputs.delete(sessionId);
    await this.adapterFor(session.agentKind).answerUserInput(sessionId, requestId, response);
  }

  /** One event from the adapter: persist first (assigns the real sequence), then broadcast
   *  the STORED event. A `session_status_changed` routes through `EventStore.updateSessionStatus`
   *  (which itself calls `assertTransition`) before that persist — an illegal jump is logged and
   *  surfaced as a synthetic `error` event instead of corrupting the session's status. */
  private handleAdapterEvent(sessionId: string, event: AgentEvent): void {
    if (event.type === "session_status_changed") {
      try {
        this.store.updateSessionStatus(sessionId, event.status);
      } catch (err) {
        if (err instanceof InvalidTransitionError) {
          this.logger.error(
            { sessionId, from: err.from, to: err.to },
            "rejected illegal session status transition",
          );
          const surfaced = this.store.appendEvent(sessionId, {
            type: "error",
            source: "agentdeck",
            message: `rejected illegal transition ${err.from} -> ${err.to}`,
            recoverable: true,
          });
          this.hub.publish(sessionId, surfaced);
          return;
        }
        throw err;
      }
    }

    const stored = this.store.appendEvent(sessionId, event);

    if (stored.type === "session_started" && stored.externalSessionId) {
      this.externalSessionIds.set(sessionId, stored.externalSessionId);
    }
    if (stored.type === "approval_requested") {
      this.pendingApprovals.set(sessionId, stored.request);
    }
    if (stored.type === "user_input_requested") {
      this.pendingUserInputs.set(sessionId, { requestId: stored.requestId, prompt: stored.prompt });
    }

    this.hub.publish(sessionId, stored);
  }
}
