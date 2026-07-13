import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";
import { runMigrations } from "./migrations.js";

export type AppDatabase = BetterSQLite3Database<typeof schema>;

export interface OpenedDatabase {
  readonly sqlite: Database.Database;
  readonly db: AppDatabase;
  close(): void;
}

/**
 * Open (creating if needed) a SQLite database and apply migrations. Pass `:memory:` (the
 * default) or a temp file path for tests; a real file path for persistent use.
 */
export function openDatabase(path: string = ":memory:"): OpenedDatabase {
  const sqlite = new Database(path);
  sqlite.pragma("foreign_keys = ON");
  runMigrations(sqlite);
  const db = drizzle(sqlite, { schema });
  return { sqlite, db, close: () => sqlite.close() };
}
