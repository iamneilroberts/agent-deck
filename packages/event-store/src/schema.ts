// Drizzle table definitions mirroring the shared Zod schemas (domain.ts, events.ts). Base
// event columns are indexed; type-specific fields live in the `payload` JSON column.
import { sqliteTable, text, integer, unique, index } from "drizzle-orm/sqlite-core";

export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  repositoryPath: text("repository_path").notNull(),
  defaultBranch: text("default_branch"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const agentSessions = sqliteTable(
  "agent_sessions",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    agentKind: text("agent_kind").notNull(),
    externalSessionId: text("external_session_id"),
    workingDirectory: text("working_directory").notNull(),
    branch: text("branch"),
    status: text("status").notNull(),
    title: text("title"),
    startedAt: text("started_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    endedAt: text("ended_at"),
  },
  (table) => [index("idx_agent_sessions_project_id").on(table.projectId)],
);

export const agentEvents = sqliteTable(
  "agent_events",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => agentSessions.id),
    sequence: integer("sequence").notNull(),
    timestamp: text("timestamp").notNull(),
    source: text("source").notNull(),
    type: text("type").notNull(),
    /** Type-specific fields (everything on `AgentEvent` beyond the base columns), as JSON. */
    payload: text("payload", { mode: "json" }).notNull(),
  },
  (table) => [unique("uq_agent_events_session_sequence").on(table.sessionId, table.sequence)],
);
