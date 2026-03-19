export interface SessionStats {
  compactionCount: number;
  lastCompactionTokensBefore: number | null;
  lastCompactionTokensAfter: number | null;
  lastCompactionReason: string | null;
  canonicalContext: Record<string, any>[] | null;
}

export interface SessionEvent {
  id?: number;
  sessionId: string;
  type: string;
  payload: Record<string, unknown>;
  createdAt?: string;
}

export interface MessageRecord {
  runId: string | null;
  data: Record<string, any>;
}

export interface MemoryStorageAdapter {
  init(): Promise<void>;
  appendMessage(
    sessionId: string,
    runId: string | null,
    message: Record<string, any>,
  ): Promise<void>;
  listMessages(sessionId: string): Promise<MessageRecord[]>;
  replaceMessages(sessionId: string, records: MessageRecord[]): Promise<void>;
  clearSession(sessionId: string): Promise<void>;
  appendEvent(event: SessionEvent): Promise<void>;
  listEvents(sessionId: string, limit?: number): Promise<SessionEvent[]>;
  getStats(sessionId: string): Promise<SessionStats>;
  updateStats(sessionId: string, patch: Partial<SessionStats>): Promise<void>;
  dispose(): Promise<void>;
}
