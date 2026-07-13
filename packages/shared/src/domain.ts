// Vendor-neutral domain model. Zod schemas are the single source of truth; TS types are
// inferred from them so the runtime validator and the compile-time type never drift.
import { z } from "zod";

/** Which coding agent backs a session. Adapters translate to/from vendor protocols. */
export const AgentKindSchema = z.enum(["codex", "claude"]);
export type AgentKind = z.infer<typeof AgentKindSchema>;

/**
 * Current activity of a session — an explicit state machine (see state-machine.ts), not a bag
 * of booleans. `waiting_for_*` are the states that surface a phone notification / action badge.
 */
export const SessionStatusSchema = z.enum([
  "starting",
  "running",
  "waiting_for_user",
  "waiting_for_approval",
  "paused",
  "completed",
  "failed",
  "stopped",
]);
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

/** ISO-8601 timestamp string. */
export const IsoTimestampSchema = z.string().datetime({ offset: true });

/** A registered repository the user can run agents against. */
export const ProjectSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  /** Absolute path to the git repository on the host. */
  repositoryPath: z.string().min(1),
  defaultBranch: z.string().min(1).optional(),
  createdAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
});
export type Project = z.infer<typeof ProjectSchema>;

/**
 * A single agent run inside a project. `externalSessionId` is the vendor's own id (Codex
 * thread id / Claude session id) used to resume; it is absent until the adapter reports it.
 */
export const AgentSessionSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  agentKind: AgentKindSchema,
  externalSessionId: z.string().optional(),
  /** Absolute working directory for this session (a repo root or a git worktree). */
  workingDirectory: z.string().min(1),
  branch: z.string().optional(),
  status: SessionStatusSchema,
  title: z.string().optional(),
  startedAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
  endedAt: IsoTimestampSchema.optional(),
});
export type AgentSession = z.infer<typeof AgentSessionSchema>;
