import sqlite3 from "sqlite3";
import type { RecollectMessage } from "../types.js";
import type {
  MemoryStorageAdapter,
  SessionEvent,
  SessionStats,
} from "./types.js";

export class SQLiteStorageAdapter implements MemoryStorageAdapter {
  private db: sqlite3.Database;

  constructor(databasePath: string) {
    this.db = new sqlite3.Database(databasePath);
  }

  async init(): Promise<void> {
    await this.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sessionId TEXT NOT NULL,
        role TEXT NOT NULL,
        data TEXT NOT NULL,
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_session_id ON messages(sessionId);

      CREATE TABLE IF NOT EXISTS session_stats (
        sessionId TEXT PRIMARY KEY,
        compactionCount INTEGER NOT NULL DEFAULT 0,
        lastCompactionTokensBefore INTEGER,
        lastCompactionTokensAfter INTEGER,
        lastCompactionReason TEXT,
        canonicalContext TEXT,
        updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS session_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sessionId TEXT NOT NULL,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_session_events_session_id_id
      ON session_events(sessionId, id);
    `);
  }

  private run(sql: string, params: any[] = []): Promise<void> {
    return new Promise((resolve, reject) => {
      this.db.run(sql, params, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  private all<T>(sql: string, params: any[] = []): Promise<T[]> {
    return new Promise((resolve, reject) => {
      this.db.all(sql, params, (err, rows) => {
        if (err) reject(err);
        else resolve(rows as T[]);
      });
    });
  }

  private exec(sql: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.db.exec(sql, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  async appendMessage(
    sessionId: string,
    message: RecollectMessage,
  ): Promise<void> {
    await this.run(
      "INSERT INTO messages (sessionId, role, data) VALUES (?, ?, ?)",
      [sessionId, message.role, JSON.stringify(message)],
    );
  }

  async listMessages(sessionId: string): Promise<RecollectMessage[]> {
    const rows = await this.all<{
      id: number;
      data: string;
    }>("SELECT id, data FROM messages WHERE sessionId = ? ORDER BY id ASC", [
      sessionId,
    ]);

    return rows.map((row) => {
      try {
        return JSON.parse(row.data) as RecollectMessage;
      } catch (error) {
        throw new Error(
          `Invalid message JSON in session '${sessionId}' row ${row.id}: ${(error as Error).message}`,
        );
      }
    });
  }

  async replaceMessages(
    sessionId: string,
    messages: RecollectMessage[],
  ): Promise<void> {
    await this.exec("BEGIN TRANSACTION");
    try {
      await this.clearSession(sessionId);
      for (const message of messages) {
        await this.appendMessage(sessionId, message);
      }
      await this.exec("COMMIT");
    } catch (error) {
      await this.exec("ROLLBACK");
      throw error;
    }
  }

  async clearSession(sessionId: string): Promise<void> {
    await this.run("DELETE FROM messages WHERE sessionId = ?", [sessionId]);
  }

  async appendEvent(event: SessionEvent): Promise<void> {
    await this.run(
      "INSERT INTO session_events (sessionId, type, payload) VALUES (?, ?, ?)",
      [event.sessionId, event.type, JSON.stringify(event.payload)],
    );
  }

  async listEvents(sessionId: string, limit = 200): Promise<SessionEvent[]> {
    const rows = await this.all<{
      id: number;
      sessionId: string;
      type: string;
      payload: string;
      createdAt: string;
    }>(
      "SELECT id, sessionId, type, payload, createdAt FROM session_events WHERE sessionId = ? ORDER BY id DESC LIMIT ?",
      [sessionId, limit],
    );

    return rows.reverse().map((row) => ({
      id: row.id,
      sessionId: row.sessionId,
      type: row.type,
      payload: JSON.parse(row.payload) as Record<string, unknown>,
      createdAt: row.createdAt,
    }));
  }

  async getStats(sessionId: string): Promise<SessionStats> {
    const rows = await this.all<{
      compactionCount: number;
      lastCompactionTokensBefore: number | null;
      lastCompactionTokensAfter: number | null;
      lastCompactionReason: string | null;
      canonicalContext: string | null;
    }>(
      "SELECT compactionCount, lastCompactionTokensBefore, lastCompactionTokensAfter, lastCompactionReason, canonicalContext FROM session_stats WHERE sessionId = ? LIMIT 1",
      [sessionId],
    );
    const row = rows[0];
    if (!row) {
      return {
        compactionCount: 0,
        lastCompactionTokensBefore: null,
        lastCompactionTokensAfter: null,
        lastCompactionReason: null,
        canonicalContext: null,
      };
    }
    return {
      compactionCount: row.compactionCount ?? 0,
      lastCompactionTokensBefore: row.lastCompactionTokensBefore ?? null,
      lastCompactionTokensAfter: row.lastCompactionTokensAfter ?? null,
      lastCompactionReason: row.lastCompactionReason ?? null,
      canonicalContext: row.canonicalContext
        ? (JSON.parse(row.canonicalContext) as RecollectMessage[])
        : null,
    };
  }

  async updateStats(
    sessionId: string,
    patch: Partial<SessionStats>,
  ): Promise<void> {
    const current = await this.getStats(sessionId);
    const merged: SessionStats = {
      compactionCount: patch.compactionCount ?? current.compactionCount,
      lastCompactionTokensBefore:
        patch.lastCompactionTokensBefore ?? current.lastCompactionTokensBefore,
      lastCompactionTokensAfter:
        patch.lastCompactionTokensAfter ?? current.lastCompactionTokensAfter,
      lastCompactionReason:
        patch.lastCompactionReason ?? current.lastCompactionReason,
      canonicalContext: patch.canonicalContext ?? current.canonicalContext,
    };

    await this.run(
      `INSERT INTO session_stats (
        sessionId,
        compactionCount,
        lastCompactionTokensBefore,
        lastCompactionTokensAfter,
        lastCompactionReason,
        canonicalContext,
        updatedAt
      ) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(sessionId) DO UPDATE SET
        compactionCount = excluded.compactionCount,
        lastCompactionTokensBefore = excluded.lastCompactionTokensBefore,
        lastCompactionTokensAfter = excluded.lastCompactionTokensAfter,
        lastCompactionReason = excluded.lastCompactionReason,
        canonicalContext = excluded.canonicalContext,
        updatedAt = CURRENT_TIMESTAMP`,
      [
        sessionId,
        merged.compactionCount,
        merged.lastCompactionTokensBefore,
        merged.lastCompactionTokensAfter,
        merged.lastCompactionReason,
        merged.canonicalContext
          ? JSON.stringify(merged.canonicalContext)
          : null,
      ],
    );
  }

  async dispose(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.db.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }
}
