import { describe, expect, it } from "vitest";
import { applyServerMessage, initialEventsState, nextBackoffMs } from "../src/ws/reducer";
import { assistantDelta } from "./fixtures/events";
import type { ServerMessage } from "../src/ws/protocol";

describe("nextBackoffMs", () => {
  it("doubles each attempt starting at 1s", () => {
    expect(nextBackoffMs(0)).toBe(1000);
    expect(nextBackoffMs(1)).toBe(2000);
    expect(nextBackoffMs(2)).toBe(4000);
    expect(nextBackoffMs(3)).toBe(8000);
  });

  it("caps at 15s", () => {
    expect(nextBackoffMs(10)).toBe(15_000);
  });
});

describe("applyServerMessage", () => {
  it("applies hello_ok and moves to replaying", () => {
    const state = applyServerMessage(initialEventsState(), {
      type: "hello_ok",
      sessionId: "s1",
      headSequence: 5,
    });
    expect(state.status).toBe("replaying");
    expect(state.sessionId).toBe("s1");
  });

  it("appends events in order and tracks lastSeq", () => {
    const e1 = assistantDelta(1, "item-1", "Hello");
    const e2 = assistantDelta(2, "item-1", " world");
    let state = initialEventsState();
    state = applyServerMessage(state, { type: "event", event: e1 } as ServerMessage);
    state = applyServerMessage(state, { type: "event", event: e2 } as ServerMessage);
    expect(state.events).toEqual([e1, e2]);
    expect(state.lastSeq).toBe(2);
  });

  it("de-dupes an event with sequence <= lastSeq (no gaps, no duplicates on replay overlap)", () => {
    const e1 = assistantDelta(1, "item-1", "Hello");
    let state = initialEventsState();
    state = applyServerMessage(state, { type: "event", event: e1 } as ServerMessage);
    // Simulate a duplicate delivery of the same sequence (e.g. a reconnect race).
    state = applyServerMessage(state, { type: "event", event: e1 } as ServerMessage);
    expect(state.events).toHaveLength(1);
    expect(state.lastSeq).toBe(1);
  });

  it("replay_complete flips status to live", () => {
    const state = applyServerMessage(initialEventsState(), {
      type: "replay_complete",
      headSequence: 3,
    });
    expect(state.status).toBe("live");
  });

  it("heartbeat records the timestamp without touching events", () => {
    const state = applyServerMessage(initialEventsState(), { type: "heartbeat", ts: 12345 });
    expect(state.lastHeartbeatTs).toBe(12345);
    expect(state.events).toHaveLength(0);
  });

  it("error sets status and message", () => {
    const state = applyServerMessage(initialEventsState(), { type: "error", message: "boom" });
    expect(state.status).toBe("error");
    expect(state.errorMessage).toBe("boom");
  });
});
