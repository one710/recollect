import type {
  PostgresStorageAdapter,
  PostgresStorageConfig,
} from "./storage/postgres.js";
import type {
  SupabaseStorageAdapter,
  SupabaseStorageConfig,
} from "./storage/supabase.js";

export type {
  MessageRecord,
  MemoryStorageAdapter,
  SessionEvent,
  SessionStats,
} from "./storage/types.js";
export type { PostgresStorageConfig, SupabaseStorageConfig };
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

export async function createSupabaseStorageAdapter(
  config: SupabaseStorageConfig,
): Promise<SupabaseStorageAdapter> {
  const { SupabaseStorageAdapter: Adapter } =
    await import("./storage/supabase.js");
  return new Adapter(config);
}
