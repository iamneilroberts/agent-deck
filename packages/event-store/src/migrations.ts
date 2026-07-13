// Hand-written SQL migrations, applied in order and tracked in a `schema_migrations` table so
// re-opening an existing DB file is a no-op. Kept as plain SQL (rather than drizzle-kit
// generated files) so the package has no build-time codegen step.
export interface Migration {
  readonly name: string;
  readonly sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    name: "0001_init",
    sql: `
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        repository_path TEXT NOT NULL,
        default_branch TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE agent_sessions (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        agent_kind TEXT NOT NULL,
        external_session_id TEXT,
        working_directory TEXT NOT NULL,
        branch TEXT,
        status TEXT NOT NULL,
        title TEXT,
        started_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        ended_at TEXT
      );
      CREATE INDEX idx_agent_sessions_project_id ON agent_sessions(project_id);

      CREATE TABLE agent_events (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES agent_sessions(id),
        sequence INTEGER NOT NULL,
        timestamp TEXT NOT NULL,
        source TEXT NOT NULL,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        UNIQUE(session_id, sequence)
      );
    `,
  },
];

/** Apply any migrations not yet recorded in `schema_migrations`, in order. Idempotent. */
export function runMigrations(sqlite: import("better-sqlite3").Database): void {
  sqlite.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`,
  );
  const applied = new Set(
    sqlite
      .prepare("SELECT name FROM schema_migrations")
      .all()
      .map((row) => (row as { name: string }).name),
  );
  const insertApplied = sqlite.prepare(
    "INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)",
  );
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.name)) continue;
    sqlite.exec(migration.sql);
    insertApplied.run(migration.name, new Date().toISOString());
  }
}
