export type {
  MessageRecord,
  MemoryStorageAdapter,
  SessionEvent,
  SessionStats,
} from "./storage/types.js";
export { InMemoryStorageAdapter } from "./storage/in-memory.js";
export { FilesystemStorageAdapter } from "./storage/filesystem.js";

export async function createSQLiteStorageAdapter(databasePath: string) {
  const { SQLiteStorageAdapter } = await import("./storage/sqlite.js");
  return new SQLiteStorageAdapter(databasePath);
}
