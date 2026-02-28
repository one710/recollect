import type { LanguageModelV3Message } from "@ai-sdk/provider";

export interface SessionStats {
  compactionCount: number;
  lastCompactionTokensBefore: number | null;
  lastCompactionTokensAfter: number | null;
  lastCompactionReason: string | null;
  canonicalContext: LanguageModelV3Message[] | null;
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
  appendMessage(
    sessionId: string,
    message: LanguageModelV3Message,
  ): Promise<void>;
  listMessages(sessionId: string): Promise<LanguageModelV3Message[]>;
  replaceMessages(
    sessionId: string,
    messages: LanguageModelV3Message[],
  ): Promise<void>;
  clearSession(sessionId: string): Promise<void>;
  appendEvent(event: SessionEvent): Promise<void>;
  listEvents(sessionId: string, limit?: number): Promise<SessionEvent[]>;
  getStats(sessionId: string): Promise<SessionStats>;
  updateStats(sessionId: string, patch: Partial<SessionStats>): Promise<void>;
  dispose(): Promise<void>;
}
