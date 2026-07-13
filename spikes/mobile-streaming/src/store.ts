import { randomUUID } from "node:crypto";
import type { AgentEvent, AgentEventType } from "./events.js";

/**
 * Pure gap-replay logic, isolated from I/O so it's directly unit-testable: every event whose
 * sequence is strictly greater than `lastSeq`, in ascending order. `events` is assumed already
 * sorted by sequence (true for anything produced by EventStore.append).
 */
export function selectSince(events: readonly AgentEvent[], lastSeq: number): AgentEvent[] {
  return events.filter((event) => event.sequence > lastSeq);
}

/** In-memory event log for a single fake session with monotonic per-session sequence numbers. */
export class EventStore {
  private readonly events: AgentEvent[] = [];
  private nextSequence = 1;

  constructor(private readonly sessionId: string) {}

  append(type: AgentEventType, payload: Record<string, unknown>): AgentEvent {
    const event: AgentEvent = {
      id: randomUUID(),
      sessionId: this.sessionId,
      sequence: this.nextSequence,
      timestamp: Date.now(),
      type,
      payload,
    };
    this.nextSequence += 1;
    this.events.push(event);
    return event;
  }

  since(lastSeq: number): AgentEvent[] {
    return selectSince(this.events, lastSeq);
  }

  get headSequence(): number {
    return this.nextSequence - 1;
  }
}
