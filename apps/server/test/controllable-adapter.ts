// A minimal `AgentAdapter` test double that pushes arbitrary events straight to subscribers,
// with NO transition-validity check of its own (unlike `FakeAdapter`, which refuses to emit an
// illegal `session_status_changed`). Exists so a test can prove the SERVER's own guard (routing
// through `EventStore.updateSessionStatus` / `assertTransition`) is what rejects an illegal
// jump — not merely relying on the adapter never producing one.
import { randomUUID } from "node:crypto";
import {
  AgentEventSchema,
  type AgentAdapter,
  type AgentEvent,
  type AgentKind,
  type ApprovalDecision,
  type InstallationStatus,
  type RecoverableSession,
  type ResumeSessionInput,
  type SessionHandle,
  type StartSessionInput,
  type UnsubscribeFunction,
} from "@agentdeck/shared";

export class ControllableAdapter implements AgentAdapter {
  readonly kind: AgentKind;
  private readonly listeners = new Map<string, Set<(event: AgentEvent) => void>>();

  constructor(kind: AgentKind = "claude") {
    this.kind = kind;
  }

  async detectInstallation(): Promise<InstallationStatus> {
    return { installed: true, version: "controllable-test-adapter" };
  }

  async startSession(input: StartSessionInput): Promise<SessionHandle> {
    return { sessionId: input.sessionId };
  }

  async resumeSession(input: ResumeSessionInput): Promise<SessionHandle> {
    return { sessionId: input.sessionId, externalSessionId: input.externalSessionId };
  }

  async sendMessage(): Promise<void> {}
  async approve(_sessionId: string, _decision: ApprovalDecision): Promise<void> {}
  async answerUserInput(): Promise<void> {}
  async interrupt(): Promise<void> {}
  async stop(): Promise<void> {}

  async listRecoverableSessions(): Promise<RecoverableSession[]> {
    return [];
  }

  subscribe(sessionId: string, listener: (event: AgentEvent) => void): UnsubscribeFunction {
    let set = this.listeners.get(sessionId);
    if (!set) {
      set = new Set();
      this.listeners.set(sessionId, set);
    }
    set.add(listener);
    return () => set?.delete(listener);
  }

  /** Test-only: push a partial event (validated/completed against `AgentEventSchema`) straight
   *  to this session's subscribers, bypassing any transition check. */
  push(sessionId: string, partial: Record<string, unknown>): void {
    const event = AgentEventSchema.parse({
      id: randomUUID(),
      sessionId,
      sequence: 0,
      timestamp: new Date().toISOString(),
      ...partial,
    });
    for (const listener of this.listeners.get(sessionId) ?? []) listener(event);
  }
}
