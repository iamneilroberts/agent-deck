// The normalized event model — the canonical stream both adapters map into and the UI renders.
// Raw vendor terminal bytes are NEVER the canonical form (ADR-0001). Every event carries a
// monotonic per-session `sequence` so the browser can reconnect and replay from last-seen
// (proven in spikes/mobile-streaming). Zod is the source of truth; TS types are inferred.
import { z } from "zod";
import { IsoTimestampSchema, SessionStatusSchema } from "./domain.js";
import { ApprovalRequestSchema } from "./approvals.js";

/** Which side produced the event: a vendor adapter, or AgentDeck itself (status, handoff). */
export const EventSourceSchema = z.enum(["codex", "claude", "agentdeck"]);
export type EventSource = z.infer<typeof EventSourceSchema>;

/** Fields on every normalized event. */
const eventBase = {
  id: z.string().uuid(),
  sessionId: z.string().uuid(),
  /** Monotonic per session, starting at 1. Used for reconnect-replay ordering. */
  sequence: z.number().int().nonnegative(),
  timestamp: IsoTimestampSchema,
  source: EventSourceSchema,
} as const;

/** Streaming phase for message-like events that arrive as token deltas then a final form. */
export const MessagePhaseSchema = z.enum(["delta", "final"]);
export type MessagePhase = z.infer<typeof MessagePhaseSchema>;

export const AgentEventSchema = z.discriminatedUnion("type", [
  z.object({
    ...eventBase,
    type: z.literal("session_started"),
    title: z.string().optional(),
    model: z.string().optional(),
    externalSessionId: z.string().optional(),
  }),
  z.object({
    ...eventBase,
    type: z.literal("session_status_changed"),
    status: SessionStatusSchema,
    previous: SessionStatusSchema.optional(),
  }),
  z.object({
    ...eventBase,
    type: z.literal("assistant_message"),
    /** Groups deltas belonging to the same message. */
    itemId: z.string(),
    text: z.string(),
    phase: MessagePhaseSchema,
  }),
  z.object({
    ...eventBase,
    type: z.literal("user_message"),
    text: z.string(),
  }),
  z.object({
    ...eventBase,
    type: z.literal("reasoning"),
    itemId: z.string(),
    text: z.string(),
    phase: MessagePhaseSchema,
  }),
  z.object({
    ...eventBase,
    type: z.literal("command_started"),
    commandId: z.string(),
    command: z.string(),
    cwd: z.string().optional(),
  }),
  z.object({
    ...eventBase,
    type: z.literal("command_output"),
    commandId: z.string(),
    chunk: z.string(),
    stream: z.enum(["stdout", "stderr", "merged"]),
  }),
  z.object({
    ...eventBase,
    type: z.literal("command_completed"),
    commandId: z.string(),
    exitCode: z.number().int().nullable().optional(),
    durationMs: z.number().nonnegative().optional(),
  }),
  z.object({
    ...eventBase,
    type: z.literal("tool_started"),
    toolCallId: z.string(),
    toolName: z.string(),
    input: z.unknown().optional(),
  }),
  z.object({
    ...eventBase,
    type: z.literal("tool_output"),
    toolCallId: z.string(),
    output: z.unknown().optional(),
    ok: z.boolean().optional(),
  }),
  z.object({
    ...eventBase,
    type: z.literal("file_changed"),
    path: z.string(),
    changeType: z.enum(["added", "modified", "deleted"]),
    /** Unified diff, when the adapter has it. */
    diff: z.string().optional(),
  }),
  z.object({
    ...eventBase,
    type: z.literal("approval_requested"),
    request: ApprovalRequestSchema,
  }),
  z.object({
    ...eventBase,
    type: z.literal("user_input_requested"),
    requestId: z.string(),
    prompt: z.string(),
    /** Optional structured questions (Codex requestUserInput). */
    questions: z.array(z.string()).optional(),
  }),
  z.object({
    ...eventBase,
    type: z.literal("test_result"),
    passed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    total: z.number().int().nonnegative().optional(),
    summary: z.string().optional(),
  }),
  z.object({
    ...eventBase,
    type: z.literal("artifact_created"),
    artifactType: z.enum(["screenshot", "trace", "report", "video", "log", "other"]),
    /** Absolute path on the host; the file is served by reference, not copied into the DB. */
    path: z.string(),
    mimeType: z.string().optional(),
  }),
  z.object({
    ...eventBase,
    type: z.literal("error"),
    message: z.string(),
    /** Whether the agent intends to retry. */
    recoverable: z.boolean().optional(),
  }),
]);
export type AgentEvent = z.infer<typeof AgentEventSchema>;

/** The `type` discriminant values, for exhaustive handling in UIs and adapters. */
export type AgentEventType = AgentEvent["type"];

/** Narrow an event by its `type` discriminant. */
export type AgentEventOf<T extends AgentEventType> = Extract<AgentEvent, { type: T }>;
