// Fan-out of stored (sequence-assigned) events to connected WebSocket subscribers of a
// session. Deliberately separate from the adapter's own `subscribe` — that one feeds the
// lifecycle wiring (which persists first); this one feeds live browser clients only after
// persistence, per the "persist then broadcast" guarantee in docs/api-contract.md.
import type { AgentEvent } from "@agentdeck/shared";

type Listener = (event: AgentEvent) => void;

export class SessionEventHub {
  private readonly subscribers = new Map<string, Set<Listener>>();

  subscribe(sessionId: string, listener: Listener): () => void {
    let set = this.subscribers.get(sessionId);
    if (!set) {
      set = new Set();
      this.subscribers.set(sessionId, set);
    }
    set.add(listener);
    return () => {
      set?.delete(listener);
      if (set && set.size === 0) this.subscribers.delete(sessionId);
    };
  }

  publish(sessionId: string, event: AgentEvent): void {
    for (const listener of this.subscribers.get(sessionId) ?? []) listener(event);
  }
}
