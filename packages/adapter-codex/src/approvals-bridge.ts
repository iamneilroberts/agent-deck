// The approval bridge — the crux of the adapter (design §5). Codex approvals are server-INITIATED
// requests the transport answers by RETURNING a value from its handler. AgentDeck cannot answer
// synchronously (the phone decides), so for a supported approval the bridge:
//   1. maps the request -> a neutral ApprovalRequest (or user_input) DRAFT, emitted to the phone;
//   2. returns an UNRESOLVED promise that the transport holds open as the pending wire response;
//   3. resolves that promise later, when `resolveApproval`/`resolveUserInput` arrives — resolving
//      it IS sending the Codex response.
// Faithful-transport invariant (approvals.ts): options are ONLY what the agent offered — the wire
// `availableDecisions` for commands, or the generated fixed enum for fileChange (which transmits
// no list). Unsupported approval kinds are auto-declined via an error response (never granted).
import type { ApprovalOption, ApprovalOptionKind, ApprovalRequest } from "@agentdeck/shared";
import type { CodexEventDraft } from "./mapping.js";
import {
  FILE_CHANGE_DECISIONS,
  SERVER_REQUEST_METHODS,
  type CommandExecutionApprovalDecision,
  type CommandExecutionRequestApprovalParams,
  type FileChangeApprovalDecision,
  type FileChangeRequestApprovalParams,
  type ToolRequestUserInputParams,
  type WireServerRequest,
} from "./proto.js";

export type EmitDraft = (draft: CodexEventDraft) => void;

type StringDecision = Extract<CommandExecutionApprovalDecision, string>;
const DECISION_LABEL: Record<StringDecision, string> = {
  accept: "Approve",
  acceptForSession: "Approve for session",
  decline: "Deny",
  cancel: "Cancel",
};
const DECISION_KIND: Record<StringDecision, ApprovalOptionKind> = {
  accept: "allow",
  acceptForSession: "allow_always",
  decline: "deny",
  cancel: "deny",
};
const OBJECT_DECISION_LABEL: Record<string, string> = {
  acceptWithExecpolicyAmendment: "Approve + allow similar commands",
  applyNetworkPolicyAmendment: "Approve + network rule",
};

interface Pending {
  resolve: (response: unknown) => void;
  reject: (err: Error) => void;
  kind: "approval" | "userInput";
  /** For user-input: the question ids to key answers by. */
  questionIds?: string[];
}

/** One bridge per session. Holds the promises for approvals/user-input awaiting a phone decision. */
export class CodexApprovalBridge {
  private readonly pending = new Map<string, Pending>();

  get pendingCount(): number {
    return this.pending.size;
  }

  hasPending(requestId: string): boolean {
    return this.pending.has(requestId);
  }

  /**
   * Wire this as the transport's server-request handler: `setServerRequestHandler((req) =>
   * bridge.onServerRequest(req, emit))`. Emits the neutral draft, then returns a promise the
   * transport holds open until the corresponding `resolve*` call (or `rejectAll` on crash).
   * Unsupported methods emit an `error` draft and reject (the transport turns that into a wire
   * error, i.e. a decline — never a silent grant).
   */
  onServerRequest(req: WireServerRequest, emit: EmitDraft): Promise<unknown> {
    const requestId = String(req.id);
    switch (req.method) {
      case SERVER_REQUEST_METHODS.commandApproval: {
        const p = req.params as CommandExecutionRequestApprovalParams;
        const options = commandOptions(p.availableDecisions);
        emit(approvalDraft(requestId, "command", p.command ?? "Run command", p.cwd ?? undefined, p.reason ?? undefined, p, options));
        return this.hold(requestId, "approval");
      }
      case SERVER_REQUEST_METHODS.fileChangeApproval: {
        const p = req.params as FileChangeRequestApprovalParams;
        const options = FILE_CHANGE_DECISIONS.map(stringOption);
        emit(approvalDraft(requestId, "file_change", p.reason ?? "Apply file changes", undefined, p.reason ?? undefined, p, options));
        return this.hold(requestId, "approval");
      }
      case SERVER_REQUEST_METHODS.requestUserInput: {
        const p = req.params as ToolRequestUserInputParams;
        const questions = p.questions ?? [];
        emit({
          type: "user_input_requested",
          source: "codex",
          requestId,
          prompt: questions.map((q) => q.question).join("\n") || "Input requested",
          questions: questions.length ? questions.map((q) => q.question) : undefined,
        });
        return this.hold(requestId, "userInput", questions.map((q) => q.id));
      }
      default:
        // permissions / mcpServer elicitation / dynamic tool-call: not supported in Phase 2.
        emit({ type: "error", source: "codex", message: `unsupported approval ${req.method}; auto-declined`, recoverable: true });
        return Promise.reject(new Error(`unsupported server request: ${req.method}`));
    }
  }

  /** Answer a pending approval. `optionId` must be one the request offered (server pre-validates;
   *  we defensively map it back to the Codex decision). Resolving sends `{ decision }` on the wire. */
  resolveApproval(requestId: string, optionId: string, _note?: string): void {
    const p = this.take(requestId, "approval");
    p.resolve({ decision: decodeDecision(optionId) });
  }

  /** Answer a pending `requestUserInput`. Phase-2: the single `response` answers every question. */
  resolveUserInput(requestId: string, response: string): void {
    const p = this.take(requestId, "userInput");
    const answers: { [questionId: string]: { answers: string[] } } = {};
    for (const id of p.questionIds ?? []) answers[id] = { answers: [response] };
    p.resolve({ answers });
  }

  /** Crash/close path (design §8.5): settle every held promise with an error so nothing leaks. */
  rejectAll(err: Error): void {
    for (const [, p] of this.pending) p.reject(err);
    this.pending.clear();
  }

  // ---- internals ----

  private hold(requestId: string, kind: Pending["kind"], questionIds?: string[]): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject, kind, questionIds });
    });
  }

  private take(requestId: string, kind: Pending["kind"]): Pending {
    const p = this.pending.get(requestId);
    if (!p) throw new Error(`no pending ${kind} for request ${requestId}`);
    if (p.kind !== kind) throw new Error(`request ${requestId} is a ${p.kind}, not a ${kind}`);
    this.pending.delete(requestId);
    return p;
  }
}

// ---- option <-> decision mapping (symmetric, faithful) ----

function commandOptions(available: CommandExecutionApprovalDecision[] | null | undefined): ApprovalOption[] {
  // No list -> nothing to offer faithfully; fall back to the fixed set is NOT valid for commands
  // (they always transmit a list). An empty list would violate the schema's .min(1); decline-only.
  if (!available || available.length === 0) return [stringOption("decline")];
  return available.map(decisionOption);
}

function decisionOption(d: CommandExecutionApprovalDecision): ApprovalOption {
  if (typeof d === "string") return stringOption(d);
  const key = Object.keys(d)[0] ?? "custom";
  return { id: JSON.stringify(d), label: OBJECT_DECISION_LABEL[key] ?? key, kind: "custom" };
}

function stringOption(d: StringDecision | FileChangeApprovalDecision): ApprovalOption {
  return { id: d, label: DECISION_LABEL[d] ?? d, kind: DECISION_KIND[d] ?? "custom" };
}

function approvalDraft(
  requestId: string,
  kind: ApprovalRequest["kind"],
  summary: string,
  cwd: string | undefined,
  reason: string | undefined,
  details: unknown,
  options: ApprovalOption[],
): CodexEventDraft {
  const request: ApprovalRequest = { requestId, kind, summary, options, details };
  if (cwd) request.cwd = cwd;
  if (reason) request.reason = reason;
  return { type: "approval_requested", source: "codex", request };
}

/** A string optionId is a bare decision; a JSON optionId round-trips to the object decision. */
function decodeDecision(optionId: string): unknown {
  const t = optionId.trim();
  if (t.startsWith("{")) {
    try {
      return JSON.parse(t);
    } catch {
      return optionId;
    }
  }
  return optionId;
}
