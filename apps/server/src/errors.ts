// Typed errors the lifecycle layer throws; routes translate these to HTTP status codes.
export class UnknownSessionError extends Error {
  constructor(readonly sessionId: string) {
    super(`unknown session: ${sessionId}`);
    this.name = "UnknownSessionError";
  }
}

export class UnknownProjectError extends Error {
  constructor(readonly projectId: string) {
    super(`unknown project: ${projectId}`);
    this.name = "UnknownProjectError";
  }
}

export class AdapterNotRegisteredError extends Error {
  constructor(readonly kind: string) {
    super(`no adapter registered for agentKind "${kind}"`);
    this.name = "AdapterNotRegisteredError";
  }
}

/** A resolve/respond payload that references an option/request the agent never offered. */
export class InvalidApprovalError extends Error {
  constructor(
    readonly sessionId: string,
    readonly requestId: string,
    readonly optionId: string,
  ) {
    super(`optionId "${optionId}" was not offered for approval request "${requestId}"`);
    this.name = "InvalidApprovalError";
  }
}

export class InvalidUserInputResponseError extends Error {
  constructor(
    readonly sessionId: string,
    readonly requestId: string,
  ) {
    super(`no pending user_input_requested "${requestId}" for session ${sessionId}`);
    this.name = "InvalidUserInputResponseError";
  }
}

/** `stopped` is terminal (see @agentdeck/shared state-machine.ts) — resuming means starting a new session. */
export class SessionNotResumableError extends Error {
  constructor(readonly sessionId: string) {
    super(`session ${sessionId} is stopped and cannot be resumed — start a new session instead`);
    this.name = "SessionNotResumableError";
  }
}
