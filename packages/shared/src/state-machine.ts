// Session lifecycle as an explicit state machine (plan §23: state machines, not scattered
// booleans). Pure and directly unit-tested. Adapters and the server MUST route status changes
// through `assertTransition` so an illegal jump surfaces as an error, not a silent bad write.
import type { SessionStatus } from "./domain.js";

/**
 * Allowed transitions. Notes:
 * - `stopped` is terminal (user-ended); resuming a stopped session is a NEW session, not a
 *   transition out of `stopped`.
 * - `completed` and `failed` are resting states that CAN go back to `running` — that models
 *   `resumeSession` starting a fresh turn on an existing session (proven possible for both
 *   agents in the spikes).
 * - `waiting_for_*` are entered from `running` and return to `running` once answered.
 */
const TRANSITIONS: Record<SessionStatus, readonly SessionStatus[]> = {
  starting: ["running", "failed", "stopped"],
  running: ["waiting_for_user", "waiting_for_approval", "paused", "completed", "failed", "stopped"],
  waiting_for_user: ["running", "paused", "failed", "stopped"],
  waiting_for_approval: ["running", "paused", "failed", "stopped"],
  paused: ["running", "stopped", "failed"],
  completed: ["running", "stopped"],
  failed: ["running", "stopped"],
  stopped: [],
};

export class InvalidTransitionError extends Error {
  constructor(
    readonly from: SessionStatus,
    readonly to: SessionStatus,
  ) {
    super(`invalid session transition: ${from} -> ${to}`);
    this.name = "InvalidTransitionError";
  }
}

/** Can a session move directly from `from` to `to`? (Self-transitions are not allowed.) */
export function canTransition(from: SessionStatus, to: SessionStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Assert a transition is legal, or throw `InvalidTransitionError`. Returns `to` for chaining. */
export function assertTransition(from: SessionStatus, to: SessionStatus): SessionStatus {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
  return to;
}

/** The states reachable directly from `status`. */
export function nextStates(status: SessionStatus): readonly SessionStatus[] {
  return TRANSITIONS[status];
}

/** A terminal state has no outgoing transitions (`stopped`). */
export function isTerminal(status: SessionStatus): boolean {
  return TRANSITIONS[status].length === 0;
}

/** States that should surface a phone action badge (the user must do something). */
export function needsUserAttention(status: SessionStatus): boolean {
  return status === "waiting_for_approval" || status === "waiting_for_user";
}
