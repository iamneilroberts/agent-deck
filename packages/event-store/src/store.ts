import { randomUUID } from "node:crypto";
import { and, asc, eq, gt, sql } from "drizzle-orm";
import {
  AgentEventSchema,
  AgentSessionSchema,
  ProjectSchema,
  assertTransition,
  isTerminal,
  type AgentEvent,
  type AgentSession,
  type Project,
  type SessionStatus,
} from "@agentdeck/shared";
import { openDatabase, type AppDatabase, type OpenedDatabase } from "./db.js";
import { agentEvents, agentSessions, projects } from "./schema.js";

export interface CreateProjectInput {
  id?: string;
  name: string;
  repositoryPath: string;
  defaultBranch?: string;
}

export interface CreateSessionInput {
  id?: string;
  projectId: string;
  agentKind: AgentSession["agentKind"];
  workingDirectory: string;
  branch?: string;
  title?: string;
  externalSessionId?: string;
  /** Defaults to "starting". */
  status?: SessionStatus;
}

/**
 * Plain `Omit` over a union collapses to only the keys common to every member (`Pick`'s mapped
 * type doesn't distribute), which would erase each event type's own fields. This distributes
 * `Omit` over each union member first.
 */
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

/**
 * A new event as the caller supplies it: the type-specific fields plus `source`/`type`. `id`
 * and `timestamp` are stamped by the store when absent; `sessionId` and `sequence` are always
 * assigned by the store (any values on the input are ignored).
 */
export type NewEvent = DistributiveOmit<AgentEvent, "id" | "sessionId" | "sequence" | "timestamp"> & {
  id?: string;
  timestamp?: string;
};

function nowIso(): string {
  return new Date().toISOString();
}

function rowToProject(row: typeof projects.$inferSelect): Project {
  return ProjectSchema.parse({
    id: row.id,
    name: row.name,
    repositoryPath: row.repositoryPath,
    defaultBranch: row.defaultBranch ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

function rowToSession(row: typeof agentSessions.$inferSelect): AgentSession {
  return AgentSessionSchema.parse({
    id: row.id,
    projectId: row.projectId,
    agentKind: row.agentKind,
    externalSessionId: row.externalSessionId ?? undefined,
    workingDirectory: row.workingDirectory,
    branch: row.branch ?? undefined,
    status: row.status,
    title: row.title ?? undefined,
    startedAt: row.startedAt,
    updatedAt: row.updatedAt,
    endedAt: row.endedAt ?? undefined,
  });
}

function rowToEvent(row: typeof agentEvents.$inferSelect): AgentEvent {
  const payload = row.payload as Record<string, unknown>;
  return AgentEventSchema.parse({
    id: row.id,
    sessionId: row.sessionId,
    sequence: row.sequence,
    timestamp: row.timestamp,
    source: row.source,
    type: row.type,
    ...payload,
  });
}

/**
 * Persistence for projects, agent sessions, and the agent event stream. Every write and read
 * round-trips through the shared Zod schemas, so a corrupt row surfaces as a thrown error
 * rather than a silently mis-shaped object.
 *
 * All methods are synchronous — better-sqlite3 itself is synchronous, and `appendEvent` relies
 * on that to assign sequence numbers atomically without an `await` between the read and the
 * write (see its doc comment).
 */
export class EventStore {
  private readonly opened: OpenedDatabase;
  private readonly db: AppDatabase;

  constructor(path: string = ":memory:") {
    this.opened = openDatabase(path);
    this.db = this.opened.db;
  }

  close(): void {
    this.opened.close();
  }

  // ---- projects ----

  createProject(input: CreateProjectInput): Project {
    const timestamp = nowIso();
    const row = {
      id: input.id ?? randomUUID(),
      name: input.name,
      repositoryPath: input.repositoryPath,
      defaultBranch: input.defaultBranch ?? null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.db.insert(projects).values(row).run();
    return rowToProject(row);
  }

  getProject(id: string): Project | undefined {
    const row = this.db.select().from(projects).where(eq(projects.id, id)).get();
    return row ? rowToProject(row) : undefined;
  }

  listProjects(): Project[] {
    const rows = this.db.select().from(projects).orderBy(asc(projects.createdAt)).all();
    return rows.map(rowToProject);
  }

  // ---- sessions ----

  createSession(input: CreateSessionInput): AgentSession {
    const timestamp = nowIso();
    const row = {
      id: input.id ?? randomUUID(),
      projectId: input.projectId,
      agentKind: input.agentKind,
      externalSessionId: input.externalSessionId ?? null,
      workingDirectory: input.workingDirectory,
      branch: input.branch ?? null,
      status: input.status ?? "starting",
      title: input.title ?? null,
      startedAt: timestamp,
      updatedAt: timestamp,
      endedAt: null,
    };
    this.db.insert(agentSessions).values(row).run();
    return rowToSession(row);
  }

  getSession(id: string): AgentSession | undefined {
    const row = this.db.select().from(agentSessions).where(eq(agentSessions.id, id)).get();
    return row ? rowToSession(row) : undefined;
  }

  listSessions(projectId?: string): AgentSession[] {
    const query = this.db.select().from(agentSessions).orderBy(asc(agentSessions.startedAt));
    const rows = projectId ? query.where(eq(agentSessions.projectId, projectId)).all() : query.all();
    return rows.map(rowToSession);
  }

  /** Routes through `assertTransition` — an illegal jump throws `InvalidTransitionError`. */
  updateSessionStatus(sessionId: string, status: SessionStatus): AgentSession {
    const current = this.getSession(sessionId);
    if (!current) throw new Error(`session not found: ${sessionId}`);
    assertTransition(current.status, status);

    const updatedAt = nowIso();
    const endedAt = isTerminal(status) ? updatedAt : current.endedAt;
    this.db
      .update(agentSessions)
      .set({ status, updatedAt, endedAt: endedAt ?? null })
      .where(eq(agentSessions.id, sessionId))
      .run();

    const updated = this.getSession(sessionId);
    if (!updated) throw new Error(`session vanished during update: ${sessionId}`);
    return updated;
  }

  // ---- events ----

  /**
   * Assigns the next monotonic sequence for `sessionId` (starting at 1) and persists the
   * event. The sequence read and the insert happen inside one better-sqlite3 transaction
   * (synchronous, no `await` in between), so concurrent callers can't observe or produce a
   * gap or duplicate — better-sqlite3's transaction serializes them at the SQLite level, and
   * the `UNIQUE(session_id, sequence)` constraint is a hard backstop.
   */
  appendEvent(sessionId: string, event: NewEvent): AgentEvent {
    const insert = this.opened.sqlite.transaction(() => {
      const head = this.db
        .select({ maxSeq: sql<number>`coalesce(max(${agentEvents.sequence}), 0)` })
        .from(agentEvents)
        .where(eq(agentEvents.sessionId, sessionId))
        .get();
      const sequence = (head?.maxSeq ?? 0) + 1;

      const { id, timestamp, ...rest } = event;
      const candidate = AgentEventSchema.parse({
        ...rest,
        id: id ?? randomUUID(),
        sessionId,
        sequence,
        timestamp: timestamp ?? nowIso(),
      });

      const { id: eid, sessionId: esid, sequence: eseq, timestamp: ets, source, type, ...payload } =
        candidate;
      this.db
        .insert(agentEvents)
        .values({ id: eid, sessionId: esid, sequence: eseq, timestamp: ets, source, type, payload })
        .run();

      return candidate;
    });
    return insert();
  }

  /** Replay query: every event with `sequence > lastSeq`, ascending. `[]` if `lastSeq` >= head. */
  getEventsSince(sessionId: string, lastSeq: number): AgentEvent[] {
    const rows = this.db
      .select()
      .from(agentEvents)
      .where(and(eq(agentEvents.sessionId, sessionId), gt(agentEvents.sequence, lastSeq)))
      .orderBy(asc(agentEvents.sequence))
      .all();
    return rows.map(rowToEvent);
  }

  getHeadSequence(sessionId: string): number {
    const row = this.db
      .select({ maxSeq: sql<number>`coalesce(max(${agentEvents.sequence}), 0)` })
      .from(agentEvents)
      .where(eq(agentEvents.sessionId, sessionId))
      .get();
    return row?.maxSeq ?? 0;
  }
}
