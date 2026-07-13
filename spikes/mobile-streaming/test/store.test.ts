import { describe, it, expect } from "vitest";
import { EventStore, selectSince } from "../src/store.js";
import type { AgentEvent } from "../src/events.js";

function fakeEvent(sequence: number): AgentEvent {
  return {
    id: `id-${sequence}`,
    sessionId: "s1",
    sequence,
    timestamp: sequence,
    type: "agentMessage",
    payload: { text: `#${sequence}` },
  };
}

describe("selectSince (pure gap-replay logic)", () => {
  it("returns only events strictly greater than lastSeq, in order", () => {
    const events = [1, 2, 3, 4, 5].map(fakeEvent);
    expect(selectSince(events, 2).map((e) => e.sequence)).toEqual([3, 4, 5]);
  });

  it("returns everything when lastSeq is 0", () => {
    const events = [1, 2, 3].map(fakeEvent);
    expect(selectSince(events, 0).map((e) => e.sequence)).toEqual([1, 2, 3]);
  });

  it("returns nothing when lastSeq is at or beyond the head — no bogus replay", () => {
    const events = [1, 2, 3].map(fakeEvent);
    expect(selectSince(events, 3)).toEqual([]);
    expect(selectSince(events, 999)).toEqual([]);
  });

  it("returns nothing for an empty log regardless of lastSeq", () => {
    expect(selectSince([], 0)).toEqual([]);
    expect(selectSince([], 42)).toEqual([]);
  });
});

describe("EventStore", () => {
  it("assigns monotonically increasing sequence numbers starting at 1", () => {
    const store = new EventStore("s1");
    const a = store.append("agentMessage", { text: "a" });
    const b = store.append("agentMessage", { text: "b" });
    const c = store.append("agentMessage", { text: "c" });
    expect([a.sequence, b.sequence, c.sequence]).toEqual([1, 2, 3]);
    expect(store.headSequence).toBe(3);
  });

  it("stamps every event with the store's sessionId", () => {
    const store = new EventStore("session-xyz");
    const event = store.append("commandExecution", { command: "echo hi" });
    expect(event.sessionId).toBe("session-xyz");
  });

  it("since() delegates to selectSince against its own log", () => {
    const store = new EventStore("s1");
    store.append("agentMessage", { n: 1 });
    store.append("agentMessage", { n: 2 });
    store.append("agentMessage", { n: 3 });
    expect(store.since(1).map((e) => e.sequence)).toEqual([2, 3]);
    expect(store.since(3)).toEqual([]);
  });
});
