import type { RecollectMessage } from "../types.js";

export interface SessionStats {
  compactionCount: number;
  lastCompactionTokensBefore: number | null;
  lastCompactionTokensAfter: number | null;
  lastCompactionReason: string | null;
  canonicalContext: RecollectMessage[] | null;
}

export interface SessionEvent {
  id?: number;
  sessionId: string;
  type: string;
  payload: Record<string, unknown>;
  createdAt?: string;
}

export interface MemoryStorageAdapter {
  init(): Promise<void>;
  appendMessage(sessionId: string, message: RecollectMessage): Promise<void>;
  listMessages(sessionId: string): Promise<RecollectMessage[]>;
  replaceMessages(
    sessionId: string,
    messages: RecollectMessage[],
  ): Promise<void>;
  clearSession(sessionId: string): Promise<void>;
  appendEvent(event: SessionEvent): Promise<void>;
  listEvents(sessionId: string, limit?: number): Promise<SessionEvent[]>;
  getStats(sessionId: string): Promise<SessionStats>;
  updateStats(sessionId: string, patch: Partial<SessionStats>): Promise<void>;
  dispose(): Promise<void>;
}
