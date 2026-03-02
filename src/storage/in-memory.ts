import type { RecollectMessage } from "../types.js";
import type {
  MemoryStorageAdapter,
  SessionEvent,
  SessionStats,
} from "./types.js";

export class InMemoryStorageAdapter implements MemoryStorageAdapter {
  private sessions = new Map<string, RecollectMessage[]>();
  private stats = new Map<string, SessionStats>();
  private events = new Map<string, SessionEvent[]>();
  private nextEventId = 1;

  async init(): Promise<void> {
    // No-op for in-memory adapter.
  }

  async appendMessage(
    sessionId: string,
    message: RecollectMessage,
  ): Promise<void> {
    const current = this.sessions.get(sessionId) ?? [];
    current.push(message);
    this.sessions.set(sessionId, current);
  }

  async listMessages(sessionId: string): Promise<RecollectMessage[]> {
    return [...(this.sessions.get(sessionId) ?? [])];
  }

  async replaceMessages(
    sessionId: string,
    messages: RecollectMessage[],
  ): Promise<void> {
    this.sessions.set(sessionId, [...messages]);
  }

  async clearSession(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
  }

  async appendEvent(event: SessionEvent): Promise<void> {
    const sessionEvents = this.events.get(event.sessionId) ?? [];
    sessionEvents.push({
      ...event,
      id: this.nextEventId++,
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
