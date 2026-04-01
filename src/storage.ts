import type {
  PostgresStorageAdapter,
  PostgresStorageConfig,
} from "./storage/postgres.js";

export type {
  MessageRecord,
  MemoryStorageAdapter,
  SessionEvent,
  SessionStats,
} from "./storage/types.js";
export type { PostgresStorageConfig };
export { InMemoryStorageAdapter } from "./storage/in-memory.js";
export { FilesystemStorageAdapter } from "./storage/filesystem.js";

export async function createSQLiteStorageAdapter(databasePath: string) {
  const { SQLiteStorageAdapter } = await import("./storage/sqlite.js");
  return new SQLiteStorageAdapter(databasePath);
}

export async function createPostgresStorageAdapter(
  config: PostgresStorageConfig,
): Promise<PostgresStorageAdapter> {
  const { PostgresStorageAdapter: Adapter } =
    await import("./storage/postgres.js");
  return new Adapter(config);
}
