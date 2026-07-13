// The vendor-neutral adapter boundary (ADR-0001). The server and UI depend ONLY on these
// types; Codex/Claude specifics live inside their adapter packages behind this interface.
// Non-data types (functions, handles) are plain TS; data types are the Zod-inferred ones.
import type { AgentKind, AgentSession } from "./domain.js";
import type { AgentEvent } from "./events.js";
import type { ApprovalDecision } from "./approvals.js";

export type UnsubscribeFunction = () => void;

/** Result of probing whether an agent CLI is installed and usable. */
export interface InstallationStatus {
  installed: boolean;
  /** Version string when detectable (e.g. "codex-cli 0.144.1"). */
  version?: string;
  /** Absolute path to the binary, when found. */
  path?: string;
  /** Whether the agent is authenticated (logged in), when the adapter can tell. */
  authenticated?: boolean;
  /** Human-readable reason when `installed` is false or auth is missing. */
  detail?: string;
}

export interface StartSessionInput {
  /** AgentDeck's own session id (the adapter reports the vendor id back via events/handle). */
  sessionId: string;
  /** Absolute working directory (repo root or worktree). */
  workingDirectory: string;
  /** The first user message/prompt to send, if any. */
  prompt?: string;
  /** Model override; adapter default otherwise. */
  model?: string;
}

export interface ResumeSessionInput {
  sessionId: string;
  /** The vendor session id to resume (Codex thread id / Claude session id). */
  externalSessionId: string;
  workingDirectory: string;
  /** Optional prompt to send immediately after resuming. */
  prompt?: string;
}

/** A live handle to a started/resumed session. */
export interface SessionHandle {
  sessionId: string;
  /** The vendor id, once known (may be populated asynchronously via a `session_started` event). */
  externalSessionId?: string;
}

/** A recoverable session discovered from the agent's on-disk history. */
export interface RecoverableSession {
  externalSessionId: string;
  workingDirectory: string;
  /** Best-effort preview/title of the session. */
  preview?: string;
  updatedAt?: string;
}

/**
 * The one interface the server programs against. An adapter is a faithful transport: it maps
 * the vendor protocol into normalized `AgentEvent`s and passes approvals through verbatim
 * (never inventing an option the agent did not offer — see approvals.ts).
 */
export interface AgentAdapter {
  readonly kind: AgentKind;

  /** Probe installation/auth without starting a session. */
  detectInstallation(): Promise<InstallationStatus>;

  startSession(input: StartSessionInput): Promise<SessionHandle>;
  resumeSession(input: ResumeSessionInput): Promise<SessionHandle>;

  /** Send a follow-up user message to a running/idle session. */
  sendMessage(sessionId: string, message: string): Promise<void>;

  /** Answer a pending approval. `decision.optionId` must be one the request offered. */
  approve(sessionId: string, decision: ApprovalDecision): Promise<void>;

  /** Answer a pending `user_input_requested`. */
  answerUserInput(sessionId: string, requestId: string, response: string): Promise<void>;

  /** Interrupt the in-flight turn (does not end the session). */
  interrupt(sessionId: string): Promise<void>;

  /** End the session and release its process resources. */
  stop(sessionId: string): Promise<void>;

  /** Stop every live session this adapter owns (used on server shutdown). Idempotent. */
  shutdown(): Promise<void>;

  /** Subscribe to this session's normalized event stream. */
  subscribe(sessionId: string, listener: (event: AgentEvent) => void): UnsubscribeFunction;

  /** List sessions the adapter could resume (optionally scoped to a project path). */
  listRecoverableSessions(projectPath?: string): Promise<RecoverableSession[]>;
}

/** Convenience: the subset of a session an adapter is responsible for keeping in sync. */
export type AdapterOwnedSessionFields = Pick<AgentSession, "status" | "externalSessionId" | "title">;
