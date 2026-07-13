// Vendor-neutral approval model. Core principle (ADR-0001): AgentDeck is a faithful transport,
// never a silent approver and never an inventor of options. An approval request carries the
// EXACT set of options the agent offered (Codex `availableDecisions`; Claude allow/deny); a
// decision must reference one of those option ids. Adapters translate option ids back to the
// vendor decision (Codex ReviewDecision / Claude {behavior}).
import { z } from "zod";

/** What the agent is asking permission for. Drives UI grouping, not the decision set. */
export const ApprovalKindSchema = z.enum([
  "command", // run a shell command (Codex item/commandExecution, Claude Bash)
  "file_change", // apply a patch / edit files (Codex item/fileChange)
  "tool", // a generic tool/MCP call (Claude tool_use, Codex mcpToolCall)
  "permission", // escalate a permission profile (Codex item/permissions)
  "user_input", // the agent is asking the user a question (Codex requestUserInput)
]);
export type ApprovalKind = z.infer<typeof ApprovalKindSchema>;

/**
 * Coarse semantic class of an option, for consistent UI styling ONLY. The authoritative,
 * agent-specific meaning travels in `id` (opaque to the UI, meaningful to the adapter).
 */
export const ApprovalOptionKindSchema = z.enum(["allow", "allow_always", "deny", "custom"]);
export type ApprovalOptionKind = z.infer<typeof ApprovalOptionKindSchema>;

/** One decision the agent offered for this specific request. */
export const ApprovalOptionSchema = z.object({
  /** Opaque, adapter-meaningful id (e.g. "accept", "acceptForSession", or a JSON-encoded amendment). */
  id: z.string().min(1),
  /** Human label for the button. */
  label: z.string().min(1),
  kind: ApprovalOptionKindSchema,
});
export type ApprovalOption = z.infer<typeof ApprovalOptionSchema>;

/** The neutral shape of an approval prompt, surfaced to the UI. */
export const ApprovalRequestSchema = z.object({
  /** Correlates the decision back to the agent's pending request. */
  requestId: z.string().min(1),
  kind: ApprovalKindSchema,
  /** One-line human summary (e.g. the command, or "Edit 2 files"). */
  summary: z.string(),
  /** Working directory the action would run in, when applicable. */
  cwd: z.string().optional(),
  /** Optional agent-provided reason (e.g. "needs network access"). */
  reason: z.string().optional(),
  /** Raw, adapter-specific detail for expandable display (command array, file list, tool input). */
  details: z.unknown().optional(),
  /**
   * The EXACT options the agent offered. The UI renders only these — it must not synthesize a
   * decision the agent did not offer. Never empty.
   */
  options: z.array(ApprovalOptionSchema).min(1),
});
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;

/** The user's answer. `optionId` MUST be one of the request's `options[].id`. */
export const ApprovalDecisionSchema = z.object({
  requestId: z.string().min(1),
  optionId: z.string().min(1),
  /** Optional free-text note passed back to the agent where supported. */
  note: z.string().optional(),
  /** Optional edited tool input (Claude `updatedInput` / approve-with-edits). */
  updatedInput: z.unknown().optional(),
});
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;

/** Validate that a decision references an option the request actually offered. */
export function isDecisionValidForRequest(req: ApprovalRequest, decision: ApprovalDecision): boolean {
  return decision.requestId === req.requestId && req.options.some((o) => o.id === decision.optionId);
}
