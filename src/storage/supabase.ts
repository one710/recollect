import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type {
  MessageRecord,
  MemoryStorageAdapter,
  SessionEvent,
  SessionStats,
} from "./types.js";

export type SupabaseStorageConfig = {
  url: string;
  anonKey: string;
};

function timestampToIso(value: unknown): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "string") {
    return value;
  }
  return String(value);
}

function assertNoError(
  error: { message: string } | null,
  context: string,
): void {
  if (error) {
    throw new Error(`${context}: ${error.message}`);
  }
}

type StatsRow = {
  compaction_count: number;
  last_compaction_tokens_before: number | null;
  last_compaction_tokens_after: number | null;
  last_compaction_reason: string | null;
  canonical_context: string | null;
};

export class SupabaseStorageAdapter implements MemoryStorageAdapter {
  private readonly client: SupabaseClient;

  constructor(config: SupabaseStorageConfig) {
    this.client = createClient(config.url, config.anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }

  async init(): Promise<void> {
    const { error } = await this.client.from("messages").select("id").limit(1);
    assertNoError(error, "SupabaseStorageAdapter.init(messages)");
  }

  async appendMessage(
    sessionId: string,
    runId: string | null,
    message: Record<string, any>,
  ): Promise<void> {
    const { error } = await this.client.from("messages").insert({
      session_id: sessionId,
      run_id: runId,
      data: JSON.stringify(message),
    });
    assertNoError(error, "SupabaseStorageAdapter.appendMessage");
  }

  async listMessages(sessionId: string): Promise<MessageRecord[]> {
    const { data, error } = await this.client
      .from("messages")
      .select("id, run_id, data")
      .eq("session_id", sessionId)
      .order("id", { ascending: true });

    assertNoError(error, "SupabaseStorageAdapter.listMessages");

    return (data ?? []).map((row): MessageRecord => {
      try {
        const dataParsed = JSON.parse(row.data as string) as Record<
          string,
          any
        >;
        return {
          runId: (row.run_id as string | null) ?? null,
          data: dataParsed,
        };
      } catch (e) {
        throw new Error(
          `Invalid message JSON in session '${sessionId}' row ${row.id}: ${(e as Error).message}`,
        );
      }
    });
  }

  async replaceMessages(
    sessionId: string,
    records: MessageRecord[],
  ): Promise<void> {
    const p_records = records.map((r) => ({
      run_id: r.runId,
      data: JSON.stringify(r.data),
    }));

    const { error } = await this.client.rpc("recollect_replace_messages", {
      p_session_id: sessionId,
      p_records,
    });
    assertNoError(error, "SupabaseStorageAdapter.replaceMessages");
  }

  async clearSession(sessionId: string): Promise<void> {
    const { error } = await this.client
      .from("messages")
      .delete()
      .eq("session_id", sessionId);
    assertNoError(error, "SupabaseStorageAdapter.clearSession");
  }

  async appendEvent(event: SessionEvent): Promise<void> {
    const { error } = await this.client.from("session_events").insert({
      session_id: event.sessionId,
      type: event.type,
      payload: JSON.stringify(event.payload),
    });
    assertNoError(error, "SupabaseStorageAdapter.appendEvent");
  }

  async listEvents(sessionId: string, limit = 200): Promise<SessionEvent[]> {
    const { data, error } = await this.client
      .from("session_events")
      .select("id, session_id, type, payload, created_at")
      .eq("session_id", sessionId)
      .order("id", { ascending: false })
      .limit(limit);

    assertNoError(error, "SupabaseStorageAdapter.listEvents");

    return [...(data ?? [])].reverse().map((row) => ({
      id: row.id as number,
      sessionId: row.session_id as string,
      type: row.type as string,
      payload: JSON.parse(row.payload as string) as Record<string, unknown>,
      createdAt: timestampToIso(row.created_at),
    }));
  }

  async getStats(sessionId: string): Promise<SessionStats> {
    const { data, error } = await this.client
      .from("session_stats")
      .select(
        "compaction_count, last_compaction_tokens_before, last_compaction_tokens_after, last_compaction_reason, canonical_context",
      )
      .eq("session_id", sessionId)
      .maybeSingle();

    assertNoError(error, "SupabaseStorageAdapter.getStats");

    const row = data as StatsRow | null;
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

    const { error } = await this.client.from("session_stats").upsert(
      {
        session_id: sessionId,
        compaction_count: merged.compactionCount,
        last_compaction_tokens_before: merged.lastCompactionTokensBefore,
        last_compaction_tokens_after: merged.lastCompactionTokensAfter,
        last_compaction_reason: merged.lastCompactionReason,
        canonical_context: merged.canonicalContext
          ? JSON.stringify(merged.canonicalContext)
          : null,
      },
      { onConflict: "session_id" },
    );
    assertNoError(error, "SupabaseStorageAdapter.updateStats");
  }

  async dispose(): Promise<void> {
    // Supabase client has no persistent connection to tear down.
  }

  /**
   * Clears all adapter tables. Intended for automated tests only (Postgres RPC).
   */
  async truncateAllForTesting(): Promise<void> {
    const { error } = await this.client.rpc("recollect_truncate_for_testing");
    assertNoError(error, "SupabaseStorageAdapter.truncateAllForTesting");
  }
}
