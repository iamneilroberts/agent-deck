/**
 * Fake AgentEvent shape and generator. No real agent involved — this spike proves the
 * transport/reconnect story, not any adapter. The shape mirrors the neutral event model in
 * docs/architecture.md §4: { id, sessionId, sequence, timestamp, ...source-specific }.
 */

export type AgentEventType = "agentMessage" | "commandExecution" | "fileChange" | "turnCompleted";

export interface AgentEvent {
  readonly id: string;
  readonly sessionId: string;
  readonly sequence: number;
  readonly timestamp: number;
  readonly type: AgentEventType;
  readonly payload: Readonly<Record<string, unknown>>;
}

const EVENT_TYPES: readonly AgentEventType[] = [
  "agentMessage",
  "commandExecution",
  "fileChange",
  "turnCompleted",
];

/** Deterministic type rotation so the fake stream looks like a real turn's item lifecycle. */
export function pickEventType(tick: number): AgentEventType {
  const type = EVENT_TYPES[tick % EVENT_TYPES.length];
  if (type === undefined) throw new Error("unreachable: modulo of non-empty array");
  return type;
}

export function fakePayload(type: AgentEventType, tick: number): Record<string, unknown> {
  switch (type) {
    case "agentMessage":
      return { text: `fake agent message #${tick}` };
    case "commandExecution":
      return { command: `echo tick-${tick}`, exitCode: 0 };
    case "fileChange":
      return { path: `fake/file-${tick}.ts`, changeType: "modified" };
    case "turnCompleted":
      return { status: "completed", turn: tick };
  }
}
