import type { ModelMessage } from "ai";

export interface SessionStats {
  compactionCount: number;
  lastCompactionTokensBefore: number | null;
  lastCompactionTokensAfter: number | null;
  lastCompactionReason: string | null;
  canonicalContext: ModelMessage[] | null;
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
  appendMessage(sessionId: string, message: ModelMessage): Promise<void>;
  listMessages(sessionId: string): Promise<ModelMessage[]>;
  replaceMessages(sessionId: string, messages: ModelMessage[]): Promise<void>;
  clearSession(sessionId: string): Promise<void>;
  appendEvent(event: SessionEvent): Promise<void>;
  listEvents(sessionId: string, limit?: number): Promise<SessionEvent[]>;
  getStats(sessionId: string): Promise<SessionStats>;
  updateStats(sessionId: string, patch: Partial<SessionStats>): Promise<void>;
  dispose(): Promise<void>;
}
