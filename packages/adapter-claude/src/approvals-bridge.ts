// Bridges the Claude Agent SDK's `canUseTool` callback to AgentDeck's vendor-neutral approval
// model (ADR-0001). Mirrors adapter-codex's CodexApprovalBridge: when the SDK asks permission we
// emit a neutral `approval_requested` draft and PARK the callback's promise; the phone's decision
// (via adapter.approve) resolves it, and the resolved value IS the PermissionResult the SDK awaits.
//
// Unlike Codex's JSON wire, Claude's "wire" is the return value of the callback itself — so there
// is no separate response to write; resolving the promise sends the decision.
import { randomUUID } from "node:crypto";
import type { PermissionResult, PermissionUpdate } from "@anthropic-ai/claude-agent-sdk";
import {
  isDecisionValidForRequest,
  type ApprovalDecision,
  type ApprovalKind,
  type ApprovalOption,
  type ApprovalRequest,
} from "@agentdeck/shared";
import type { ClaudeEventDraft } from "./mapping.js";

export type EmitDraft = (draft: ClaudeEventDraft) => void;

/** Extra context the SDK hands the callback (subset we use). */
export interface CanUseToolContext {
  suggestions?: PermissionUpdate[];
}

interface Pending {
  request: ApprovalRequest;
  originalInput: Record<string, unknown>;
  suggestions?: PermissionUpdate[];
  resolve: (result: PermissionResult) => void;
}

const FILE_TOOLS = new Set(["Edit", "Write", "NotebookEdit", "MultiEdit"]);
const COMMAND_TOOLS = new Set(["Bash", "BashOutput", "KillShell"]);

export class ClaudeApprovalBridge {
  private readonly pending = new Map<string, Pending>();

  get pendingCount(): number {
    return this.pending.size;
  }

  hasPending(requestId: string): boolean {
    return this.pending.has(requestId);
  }

  /** Called from the SDK's `canUseTool`. Emits a neutral request and returns the awaited promise. */
  request(
    toolName: string,
    input: Record<string, unknown>,
    ctx: CanUseToolContext,
    emit: EmitDraft,
  ): Promise<PermissionResult> {
    const requestId = randomUUID();
    const { kind, summary } = classify(toolName, input);
    const options: ApprovalOption[] = [
      { id: "allow", label: "Allow", kind: "allow" },
      { id: "deny", label: "Deny", kind: "deny" },
    ];
    // Only offer "always allow" when the SDK actually gave us rule suggestions to persist.
    if (ctx.suggestions && ctx.suggestions.length > 0) {
      options.splice(1, 0, { id: "allow_always", label: "Always allow", kind: "allow_always" });
    }
    const request: ApprovalRequest = {
      requestId,
      kind,
      summary,
      details: { toolName, input },
      options,
    };
    const promise = new Promise<PermissionResult>((resolve) => {
      this.pending.set(requestId, { request, originalInput: input, suggestions: ctx.suggestions, resolve });
    });
    emit({ type: "approval_requested", source: "claude", request });
    return promise;
  }

  /** Called from adapter.approve(). Translates the neutral decision into a PermissionResult. */
  resolve(decision: ApprovalDecision): void {
    const entry = this.pending.get(decision.requestId);
    if (!entry) throw new Error(`No pending approval for requestId ${decision.requestId}`);
    if (!isDecisionValidForRequest(entry.request, decision)) {
      throw new Error(`Option ${decision.optionId} was not offered for request ${decision.requestId}`);
    }
    this.pending.delete(decision.requestId);
    entry.resolve(this.toPermissionResult(entry, decision));
  }

  /** Deny every parked request cleanly (on stop/crash) so the SDK never hangs awaiting a decision. */
  cancelAll(reason: string): void {
    for (const [, entry] of this.pending) {
      entry.resolve({ behavior: "deny", message: reason });
    }
    this.pending.clear();
  }

  private toPermissionResult(entry: Pending, decision: ApprovalDecision): PermissionResult {
    if (decision.optionId === "deny") {
      return { behavior: "deny", message: decision.note ?? "Denied by user." };
    }
    const updatedInput = (decision.updatedInput as Record<string, unknown> | undefined) ?? entry.originalInput;
    if (decision.optionId === "allow_always" && entry.suggestions && entry.suggestions.length > 0) {
      return { behavior: "allow", updatedInput, updatedPermissions: entry.suggestions };
    }
    return { behavior: "allow", updatedInput };
  }
}

function classify(toolName: string, input: Record<string, unknown>): { kind: ApprovalKind; summary: string } {
  if (COMMAND_TOOLS.has(toolName)) {
    const command = typeof input.command === "string" ? input.command : toolName;
    return { kind: "command", summary: command };
  }
  if (FILE_TOOLS.has(toolName)) {
    const path = typeof input.file_path === "string" ? input.file_path : typeof input.notebook_path === "string" ? input.notebook_path : "files";
    return { kind: "file_change", summary: `${toolName} ${path}` };
  }
  return { kind: "tool", summary: toolName };
}
