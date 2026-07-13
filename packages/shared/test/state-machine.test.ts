import { describe, it, expect } from "vitest";
import {
  canTransition,
  assertTransition,
  nextStates,
  isTerminal,
  needsUserAttention,
  InvalidTransitionError,
} from "../src/state-machine.js";
import { SessionStatusSchema, type SessionStatus } from "../src/domain.js";

const ALL: SessionStatus[] = SessionStatusSchema.options;

describe("state machine", () => {
  it("allows the core happy path", () => {
    expect(canTransition("starting", "running")).toBe(true);
    expect(canTransition("running", "waiting_for_approval")).toBe(true);
    expect(canTransition("waiting_for_approval", "running")).toBe(true);
    expect(canTransition("running", "completed")).toBe(true);
    expect(canTransition("completed", "running")).toBe(true); // resume as a new turn
  });

  it("forbids self-transitions", () => {
    for (const s of ALL) expect(canTransition(s, s)).toBe(false);
  });

  it("treats only `stopped` as terminal", () => {
    expect(isTerminal("stopped")).toBe(true);
    for (const s of ALL.filter((x) => x !== "stopped")) expect(isTerminal(s)).toBe(false);
  });

  it("cannot leave a terminal state", () => {
    expect(nextStates("stopped")).toHaveLength(0);
    for (const to of ALL) expect(canTransition("stopped", to)).toBe(false);
  });

  it("assertTransition throws a typed error on an illegal jump", () => {
    expect(() => assertTransition("completed", "waiting_for_approval")).toThrow(InvalidTransitionError);
    try {
      assertTransition("stopped", "running");
    } catch (e) {
      expect(e).toBeInstanceOf(InvalidTransitionError);
      expect((e as InvalidTransitionError).from).toBe("stopped");
      expect((e as InvalidTransitionError).to).toBe("running");
    }
  });

  it("assertTransition returns the target on a legal jump", () => {
    expect(assertTransition("running", "paused")).toBe("paused");
  });

  it("flags the attention-needing states", () => {
    expect(needsUserAttention("waiting_for_approval")).toBe(true);
    expect(needsUserAttention("waiting_for_user")).toBe(true);
    expect(needsUserAttention("running")).toBe(false);
  });

  it("every transition target is itself a valid status (no typos in the table)", () => {
    for (const from of ALL) {
      for (const to of nextStates(from)) {
        expect(ALL).toContain(to);
      }
    }
  });
});
