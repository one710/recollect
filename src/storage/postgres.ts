import pg from "pg";
import type {
  MessageRecord,
  MemoryStorageAdapter,
  SessionEvent,
  SessionStats,
} from "./types.js";

export type PostgresStorageConfig = string | pg.PoolConfig;

function timestampToIso(value: unknown): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "string") {
    return value;
  }
  return String(value);
}

export class PostgresStorageAdapter implements MemoryStorageAdapter {
  private readonly pool: pg.Pool;

  constructor(config: PostgresStorageConfig) {
    this.pool =
      typeof config === "string"
        ? new pg.Pool({ connectionString: config })
        : new pg.Pool(config);
  }

  async init(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id SERIAL PRIMARY KEY,
        session_id TEXT NOT NULL,
        run_id TEXT,
        data TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages (session_id);

      CREATE TABLE IF NOT EXISTS session_stats (
        session_id TEXT PRIMARY KEY,
        compaction_count INTEGER NOT NULL DEFAULT 0,
        last_compaction_tokens_before INTEGER,
        last_compaction_tokens_after INTEGER,
        last_compaction_reason TEXT,
        canonical_context TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS session_events (
        id SERIAL PRIMARY KEY,
        session_id TEXT NOT NULL,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_session_events_session_id_id
      ON session_events (session_id, id DESC);
    `);
  }

  async appendMessage(
    sessionId: string,
    runId: string | null,
    message: Record<string, any>,
  ): Promise<void> {
    await this.pool.query(
      "INSERT INTO messages (session_id, run_id, data) VALUES ($1, $2, $3)",
      [sessionId, runId ?? null, JSON.stringify(message)],
    );
  }

  async listMessages(sessionId: string): Promise<MessageRecord[]> {
    const result = await this.pool.query<{
      id: number;
      run_id: string | null;
      data: string;
    }>(
      "SELECT id, run_id, data FROM messages WHERE session_id = $1 ORDER BY id ASC",
      [sessionId],
    );

    return result.rows.map((row): MessageRecord => {
      try {
        const data = JSON.parse(row.data) as Record<string, any>;
        return { runId: row.run_id ?? null, data };
      } catch (error) {
        throw new Error(
          `Invalid message JSON in session '${sessionId}' row ${row.id}: ${(error as Error).message}`,
        );
      }
    });
  }

  async replaceMessages(
    sessionId: string,
    records: MessageRecord[],
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM messages WHERE session_id = $1", [
        sessionId,
      ]);
      for (const record of records) {
        await client.query(
          "INSERT INTO messages (session_id, run_id, data) VALUES ($1, $2, $3)",
          [sessionId, record.runId ?? null, JSON.stringify(record.data)],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async clearSession(sessionId: string): Promise<void> {
    await this.pool.query("DELETE FROM messages WHERE session_id = $1", [
      sessionId,
    ]);
  }

  async appendEvent(event: SessionEvent): Promise<void> {
    await this.pool.query(
      "INSERT INTO session_events (session_id, type, payload) VALUES ($1, $2, $3)",
      [event.sessionId, event.type, JSON.stringify(event.payload)],
    );
  }

  async listEvents(sessionId: string, limit = 200): Promise<SessionEvent[]> {
    const result = await this.pool.query<{
      id: number;
      session_id: string;
      type: string;
      payload: string;
      created_at: Date | string;
    }>(
      "SELECT id, session_id, type, payload, created_at FROM session_events WHERE session_id = $1 ORDER BY id DESC LIMIT $2",
      [sessionId, limit],
    );

    return [...result.rows].reverse().map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      type: row.type,
      payload: JSON.parse(row.payload) as Record<string, unknown>,
      createdAt: timestampToIso(row.created_at),
    }));
  }

  async getStats(sessionId: string): Promise<SessionStats> {
    const result = await this.pool.query<{
      compaction_count: number;
      last_compaction_tokens_before: number | null;
      last_compaction_tokens_after: number | null;
      last_compaction_reason: string | null;
      canonical_context: string | null;
    }>(
      "SELECT compaction_count, last_compaction_tokens_before, last_compaction_tokens_after, last_compaction_reason, canonical_context FROM session_stats WHERE session_id = $1 LIMIT 1",
      [sessionId],
    );
    const row = result.rows[0];
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
      compactionCount: row.compaction_count ?? 0,
      lastCompactionTokensBefore: row.last_compaction_tokens_before ?? null,
      lastCompactionTokensAfter: row.last_compaction_tokens_after ?? null,
      lastCompactionReason: row.last_compaction_reason ?? null,
      canonicalContext: row.canonical_context
        ? (JSON.parse(row.canonical_context) as Record<string, any>[])
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

    await this.pool.query(
      `INSERT INTO session_stats (
        session_id,
        compaction_count,
        last_compaction_tokens_before,
        last_compaction_tokens_after,
        last_compaction_reason,
        canonical_context,
        updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, NOW())
      ON CONFLICT (session_id) DO UPDATE SET
        compaction_count = EXCLUDED.compaction_count,
        last_compaction_tokens_before = EXCLUDED.last_compaction_tokens_before,
        last_compaction_tokens_after = EXCLUDED.last_compaction_tokens_after,
        last_compaction_reason = EXCLUDED.last_compaction_reason,
        canonical_context = EXCLUDED.canonical_context,
        updated_at = NOW()`,
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
    await this.pool.end();
  }

  /**
   * Clears all adapter tables. Intended for automated tests only.
   */
  async truncateAllForTesting(): Promise<void> {
    await this.pool.query(
      "TRUNCATE messages, session_events, session_stats RESTART IDENTITY CASCADE",
    );
  }
}
