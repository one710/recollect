export type {
  MemoryStorageAdapter,
  SessionEvent,
  SessionStats,
} from "./storage/types.js";
export { InMemoryStorageAdapter } from "./storage/in-memory.js";

export async function createSQLiteStorageAdapter(databasePath: string) {
  const { SQLiteStorageAdapter } = await import("./storage/sqlite.js");
  return new SQLiteStorageAdapter(databasePath);
}
