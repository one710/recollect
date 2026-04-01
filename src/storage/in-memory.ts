import type {
  MessageRecord,
  MemoryStorageAdapter,
  SessionEvent,
  SessionStats,
} from "./types.js";

export class InMemoryStorageAdapter implements MemoryStorageAdapter {
  protected sessions = new Map<string, MessageRecord[]>();
  protected stats = new Map<string, SessionStats>();
  protected events = new Map<string, SessionEvent[]>();
  protected nextEventId = 1;

  async init(): Promise<void> {
    // No-op for in-memory adapter.
  }

  async appendMessage(
    sessionId: string,
    runId: string | null,
    message: Record<string, any>,
  ): Promise<void> {
    const current = this.sessions.get(sessionId) ?? [];
    current.push({ data: { ...message }, runId });
    this.sessions.set(sessionId, current);
  }

  async listMessages(sessionId: string): Promise<MessageRecord[]> {
    const stored = this.sessions.get(sessionId) ?? [];
    return stored.map(({ data, runId }) => ({
      data: { ...data },
      runId,
    }));
  }

  async replaceMessages(
    sessionId: string,
    records: MessageRecord[],
  ): Promise<void> {
    const stored: MessageRecord[] = records.map((record) => ({
      runId: record.runId ?? null,
      data: { ...record.data },
    }));
    this.sessions.set(sessionId, stored);
  }

  async clearSession(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
  }

  async appendEvent(event: SessionEvent): Promise<void> {
    const sessionEvents = this.events.get(event.sessionId) ?? [];
    sessionEvents.push({
      id: this.nextEventId++,
      ...event,
      createdAt: new Date().toISOString(),
    });
    this.events.set(event.sessionId, sessionEvents);
  }

  async listEvents(sessionId: string, limit = 200): Promise<SessionEvent[]> {
    const sessionEvents = this.events.get(sessionId) ?? [];
    return sessionEvents.slice(-limit);
  }

  async getStats(sessionId: string): Promise<SessionStats> {
    return (
      this.stats.get(sessionId) ?? {
        compactionCount: 0,
        lastCompactionTokensBefore: null,
        lastCompactionTokensAfter: null,
        lastCompactionReason: null,
        canonicalContext: null,
      }
    );
  }

  async updateStats(
    sessionId: string,
    patch: Partial<SessionStats>,
  ): Promise<void> {
    const current = await this.getStats(sessionId);
    this.stats.set(sessionId, {
      compactionCount: patch.compactionCount ?? current.compactionCount,
      lastCompactionTokensBefore:
        patch.lastCompactionTokensBefore ?? current.lastCompactionTokensBefore,
      lastCompactionTokensAfter:
        patch.lastCompactionTokensAfter ?? current.lastCompactionTokensAfter,
      lastCompactionReason:
        patch.lastCompactionReason ?? current.lastCompactionReason,
      canonicalContext: patch.canonicalContext ?? current.canonicalContext,
    });
  }

  async dispose(): Promise<void> {
    this.sessions.clear();
    this.stats.clear();
    this.events.clear();
  }
}
