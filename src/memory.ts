import type { LanguageModel, ModelMessage } from "ai";
import { countMessagesTokens } from "./tokenizer.js";
import { summarizeConversation, SUMMARY_MESSAGE_PREFIX } from "./summarizer.js";
import {
  createSQLiteStorageAdapter,
  type MemoryStorageAdapter,
  type SessionEvent,
  type SessionStats,
} from "./storage.js";

export interface MemoryLayerOptions {
  /**
   * Maximum tokens allowed in the chat history before summarization is triggered.
   */
  maxTokens: number;
  /**
   * The AI SDK language model to use for summarization.
   */
  summarizationModel: LanguageModel;
  /**
   * The percentage of maxTokens (0.0 to 1.0) that triggers auto-summarization.
   * Defaults to 0.9.
   */
  threshold?: number;
  /**
   * Optional database path for default sqlite storage.
   * Defaults to 'recollect.db'.
   */
  databasePath?: string;
  /**
   * Optional pluggable storage adapter.
   * When provided, this takes precedence over databasePath.
   */
  storage?: MemoryStorageAdapter;
  /**
   * Optional custom token counter function.
   */
  countTokens?: (text: string) => number;
  /**
   * Token target to aim for after compaction.
   * Defaults to 65% of maxTokens.
   */
  targetTokensAfterCompaction?: number;
  /**
   * Keep at least this many recent user turns untouched.
   * Defaults to 4.
   */
  keepRecentUserTurns?: number;
  /**
   * Keep at least this many trailing messages untouched.
   * Defaults to 8.
   */
  keepRecentMessagesMin?: number;
  /**
   * Maximum compaction passes per addMessage.
   * Defaults to 3.
   */
  maxCompactionPasses?: number;
  /**
   * Avoid compacting very short sessions.
   * Defaults to 6.
   */
  minimumMessagesToCompact?: number;
  /**
   * Emits diagnostics for compaction lifecycle events.
   */
  onCompactionEvent?: (event: CompactionEvent) => void;
}

interface CompactionPlan {
  head: ModelMessage[];
  summarizeSlice: ModelMessage[];
  tail: ModelMessage[];
  existingSummary: string | null;
}

export type CompactionMode = "manual" | "auto-pre" | "auto-post" | "ingest";

export interface CompactionEvent {
  sessionId: string;
  mode: CompactionMode;
  reason: string;
  pass: number;
  beforeTokens: number;
  afterTokens: number;
  triggerTokens: number;
  targetTokens: number;
  summarizedMessages: number;
  keptMessages: number;
}

export interface SessionSnapshot {
  messages: ModelMessage[];
  tokenCount: number;
  stats: SessionStats;
}

interface CompactOptions {
  mode: CompactionMode;
  reason: string;
  force: boolean;
}

export class MemoryLayer {
  private storage: MemoryStorageAdapter | null;
  private storageReady: Promise<void>;
  private maxTokens: number;
  private summarizationModel: LanguageModel;
  private threshold: number;
  private customCountTokens?: ((text: string) => number) | undefined;
  private targetTokensAfterCompaction: number;
  private keepRecentUserTurns: number;
  private keepRecentMessagesMin: number;
  private maxCompactionPasses: number;
  private minimumMessagesToCompact: number;
  private onCompactionEvent: ((event: CompactionEvent) => void) | undefined;

  constructor(options: MemoryLayerOptions) {
    this.storage = options.storage ?? null;
    this.storageReady = this.initializeStorage(options);

    this.maxTokens = options.maxTokens;
    this.summarizationModel = options.summarizationModel;
    this.threshold = options.threshold ?? 0.9;
    this.customCountTokens = options.countTokens;
    this.targetTokensAfterCompaction =
      options.targetTokensAfterCompaction ??
      Math.max(1, Math.floor(this.maxTokens * 0.65));
    this.keepRecentUserTurns = Math.max(1, options.keepRecentUserTurns ?? 4);
    this.keepRecentMessagesMin = Math.max(
      1,
      options.keepRecentMessagesMin ?? 8,
    );
    this.maxCompactionPasses = Math.max(1, options.maxCompactionPasses ?? 3);
    this.minimumMessagesToCompact = Math.max(
      2,
      options.minimumMessagesToCompact ?? 6,
    );
    this.onCompactionEvent = options.onCompactionEvent;
  }

  private async ensureReady(): Promise<void> {
    await this.storageReady;
  }

  private async initializeStorage(options: MemoryLayerOptions): Promise<void> {
    if (this.storage) {
      await this.storage.init();
      return;
    }

    const databasePath = options.databasePath || "recollect.db";
    const sqliteStorage = await createSQLiteStorageAdapter(databasePath);
    await sqliteStorage.init();
    this.storage = sqliteStorage;
  }

  private requireStorage(): MemoryStorageAdapter {
    if (!this.storage) {
      throw new Error("Storage is not initialized");
    }
    return this.storage;
  }

  /**
   * Adds a message to the chat history and triggers auto-summarization if the threshold is reached.
   */
  async addMessage(
    sessionId: string,
    role: ModelMessage["role"] | null,
    contentOrMessage: string | ModelMessage,
  ): Promise<void> {
    let message: ModelMessage;

    if (role === null) {
      if (typeof contentOrMessage === "string") {
        throw new Error("Message object is required when role is null.");
      }
      message = contentOrMessage;
    } else {
      if (typeof contentOrMessage !== "string") {
        throw new Error("Content string is required when role is specified.");
      }
      message = {
        role: role as any,
        content: contentOrMessage as any,
      } as ModelMessage;
    }

    await this.ensureReady();
    await this.requireStorage().appendMessage(sessionId, message);
    await this.appendEvent({
      sessionId,
      type: "message_appended",
      payload: { role: message.role },
    });
    const history = await this.requireStorage().listMessages(sessionId);
    await this.ensureCanonicalContextSnapshot(sessionId, history);
    const tokenCount = countMessagesTokens(history, this.customCountTokens);

    if (tokenCount >= this.compactionTriggerTokens()) {
      await this.compactSession(sessionId, history, {
        mode: "ingest",
        reason: "threshold_reached_after_add_message",
        force: false,
      });
    }
  }

  /**
   * Adds multiple messages in order and triggers compaction if needed.
   */
  async addMessages(
    sessionId: string,
    messages: ModelMessage[],
  ): Promise<void> {
    await this.ensureReady();
    for (const message of messages) {
      await this.requireStorage().appendMessage(sessionId, message);
    }
    await this.appendEvent({
      sessionId,
      type: "messages_appended",
      payload: { count: messages.length },
    });
    const history = await this.requireStorage().listMessages(sessionId);
    await this.ensureCanonicalContextSnapshot(sessionId, history);
    const tokenCount = countMessagesTokens(history, this.customCountTokens);
    if (tokenCount >= this.compactionTriggerTokens()) {
      await this.compactSession(sessionId, history, {
        mode: "ingest",
        reason: "threshold_reached_after_add_messages",
        force: false,
      });
    }
  }

  /**
   * Synchronizes session memory with the incoming prompt list by appending
   * only the unseen suffix.
   */
  async syncFromPrompt(
    sessionId: string,
    promptMessages: ModelMessage[],
  ): Promise<void> {
    await this.ensureReady();
    const stored = await this.requireStorage().listMessages(sessionId);
    let prefix = 0;
    const maxPrefix = Math.min(stored.length, promptMessages.length);
    while (
      prefix < maxPrefix &&
      JSON.stringify(stored[prefix]) === JSON.stringify(promptMessages[prefix])
    ) {
      prefix += 1;
    }
    const unseen = promptMessages.slice(prefix);
    if (unseen.length > 0) {
      await this.addMessages(sessionId, unseen);
      await this.appendEvent({
        sessionId,
        type: "prompt_synced",
        payload: { unseenCount: unseen.length, prefixMatch: prefix },
      });
    }
  }

  /**
   * Returns the persisted memory for this session (suitable as model prompt).
   */
  async getPromptMessages(sessionId: string): Promise<ModelMessage[]> {
    await this.ensureReady();
    const history = await this.requireStorage().listMessages(sessionId);
    const normalized = this.normalizeHistoryForPrompt(history);
    if (!this.messagesEqual(history, normalized)) {
      await this.requireStorage().replaceMessages(sessionId, normalized);
      await this.appendEvent({
        sessionId,
        type: "history_normalized",
        payload: {
          beforeCount: history.length,
          afterCount: normalized.length,
        },
      });
      return normalized;
    }
    return history;
  }

  /**
   * Fetches the current chat history for a session.
   */
  async getMessages(sessionId: string): Promise<ModelMessage[]> {
    await this.ensureReady();
    return this.requireStorage().listMessages(sessionId);
  }

  /**
   * Forces one compaction cycle for a session.
   */
  async compactNow(sessionId: string): Promise<void> {
    await this.compactIfNeeded(sessionId, {
      mode: "manual",
      reason: "manual_compact_now",
      force: true,
    });
  }

  async compactIfNeeded(
    sessionId: string,
    options: Partial<Omit<CompactOptions, "force">> & { force?: boolean } = {},
  ): Promise<void> {
    await this.ensureReady();
    const history = await this.requireStorage().listMessages(sessionId);
    await this.compactSession(sessionId, history, {
      mode: options.mode ?? "manual",
      reason: options.reason ?? "compaction_requested",
      force: options.force ?? false,
    });
  }

  async getSessionEvents(
    sessionId: string,
    limit = 200,
  ): Promise<SessionEvent[]> {
    await this.ensureReady();
    return this.requireStorage().listEvents(sessionId, limit);
  }

  async getSessionSnapshot(sessionId: string): Promise<SessionSnapshot> {
    await this.ensureReady();
    const messages = await this.requireStorage().listMessages(sessionId);
    const tokenCount = this.messageTokens(messages);
    const stats = await this.requireStorage().getStats(sessionId);
    return { messages, tokenCount, stats };
  }

  private compactionTriggerTokens(): number {
    return Math.max(1, Math.floor(this.maxTokens * this.threshold));
  }

  private messageTokens(messages: ModelMessage[]): number {
    return countMessagesTokens(messages, this.customCountTokens);
  }

  private roleOf(message: ModelMessage): string {
    return String(message.role);
  }

  private isPinnedInstructionRole(message: ModelMessage): boolean {
    const role = this.roleOf(message);
    return role === "system" || role === "developer";
  }

  private isSummaryMessage(message: ModelMessage): boolean {
    return (
      this.roleOf(message) === "system" &&
      typeof message.content === "string" &&
      message.content.startsWith(SUMMARY_MESSAGE_PREFIX)
    );
  }

  private extractSummaryBody(content: string): string {
    const prefix = `${SUMMARY_MESSAGE_PREFIX}\n`;
    if (content.startsWith(prefix)) {
      return content.slice(prefix.length).trim();
    }
    return content.trim();
  }

  private lastUserBoundaryIndex(messages: ModelMessage[]): number | null {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (this.roleOf(messages[i] as ModelMessage) === "user") {
        return i;
      }
    }
    return null;
  }

  private leadingCanonicalContext(messages: ModelMessage[]): ModelMessage[] {
    let idx = 0;
    while (
      idx < messages.length &&
      this.isPinnedInstructionRole(messages[idx]!)
    ) {
      idx += 1;
    }
    return messages.slice(0, idx);
  }

  private messagesEqual(a: ModelMessage[], b: ModelMessage[]): boolean {
    if (a.length !== b.length) {
      return false;
    }
    for (let i = 0; i < a.length; i += 1) {
      if (JSON.stringify(a[i]) !== JSON.stringify(b[i])) {
        return false;
      }
    }
    return true;
  }

  private normalizeHistoryForPrompt(messages: ModelMessage[]): ModelMessage[] {
    const toolCalls = new Map<string, string>();
    const hasResults = new Set<string>();

    const registerToolCall = (toolCallId: unknown, toolName: unknown) => {
      if (!toolCallId || !toolName) {
        return;
      }
      toolCalls.set(String(toolCallId), String(toolName));
    };

    const recordToolResultIfKnown = (part: any) => {
      if (part?.type !== "tool-result" || !part?.toolCallId) {
        return;
      }
      const id = String(part.toolCallId);
      if (toolCalls.has(id)) {
        hasResults.add(id);
      }
    };

    for (const message of messages) {
      if (message.role !== "assistant") {
        continue;
      }

      if (Array.isArray(message.content)) {
        for (const part of message.content as any[]) {
          // AI SDK providers can encode tool calls in content parts.
          if (part?.type === "tool-call") {
            registerToolCall(part.toolCallId, part.toolName);
          }
          // Some stacks may include tool-result parts in assistant content.
          recordToolResultIfKnown(part);
        }
      }

      const calls = (message as any).toolCalls;
      if (!Array.isArray(calls)) {
        continue;
      }
      for (const call of calls) {
        registerToolCall(call.toolCallId, call.toolName);
      }
    }

    const normalized: ModelMessage[] = [];
    for (const message of messages) {
      if (message.role !== "tool") {
        normalized.push(message);
        continue;
      }

      if (!Array.isArray(message.content)) {
        normalized.push(message);
        continue;
      }

      const filteredContent = message.content.filter((part: any) => {
        if (part?.type !== "tool-result" || !part?.toolCallId) {
          return true;
        }
        const id = String(part.toolCallId);
        const knownCall = toolCalls.has(id);
        if (knownCall) {
          hasResults.add(id);
        }
        return knownCall;
      });

      if (filteredContent.length > 0) {
        normalized.push({
          ...message,
          content: filteredContent as any,
        });
      }
    }

    const missingResultParts = [...toolCalls.entries()]
      .filter(([callId]) => !hasResults.has(callId))
      .map(([toolCallId, toolName]) => ({
        type: "tool-result",
        toolCallId,
        toolName,
        result: {
          status: "missing_result",
          message:
            "Tool result was unavailable in compacted history. Continue from latest known state.",
        },
      }));

    if (missingResultParts.length > 0) {
      normalized.push({
        role: "tool",
        content: missingResultParts as any,
      } as ModelMessage);
    }

    return normalized;
  }

  private async ensureCanonicalContextSnapshot(
    sessionId: string,
    history: ModelMessage[],
  ): Promise<void> {
    const stats = await this.requireStorage().getStats(sessionId);
    if (stats.canonicalContext && stats.canonicalContext.length > 0) {
      return;
    }
    const canonical = this.leadingCanonicalContext(history);
    if (canonical.length === 0) {
      return;
    }
    await this.requireStorage().updateStats(sessionId, {
      canonicalContext: canonical,
    });
    await this.appendEvent({
      sessionId,
      type: "canonical_context_captured",
      payload: { messageCount: canonical.length },
    });
  }

  private planCompaction(
    messages: ModelMessage[],
    canonicalContext: ModelMessage[] | null,
  ): CompactionPlan | null {
    if (messages.length < this.minimumMessagesToCompact) {
      return null;
    }

    // Preserve initial instruction messages verbatim.
    const fallbackHead = this.leadingCanonicalContext(messages);
    const head =
      canonicalContext && canonicalContext.length > 0
        ? canonicalContext
        : fallbackHead;

    let pinnedHeadEnd = fallbackHead.length;
    while (
      pinnedHeadEnd < messages.length &&
      this.isPinnedInstructionRole(messages[pinnedHeadEnd] as ModelMessage)
    ) {
      pinnedHeadEnd += 1;
    }

    const userBoundaries: number[] = [];
    for (let i = pinnedHeadEnd; i < messages.length; i += 1) {
      if (this.roleOf(messages[i] as ModelMessage) === "user") {
        userBoundaries.push(i);
      }
    }

    let tailStart = messages.length;
    if (userBoundaries.length > this.keepRecentUserTurns) {
      tailStart =
        userBoundaries[userBoundaries.length - this.keepRecentUserTurns]!;
    } else {
      tailStart = Math.max(
        pinnedHeadEnd + 1,
        messages.length - this.keepRecentMessagesMin,
      );
    }

    if (tailStart <= pinnedHeadEnd) {
      return null;
    }

    const summarizeSlice = messages.slice(pinnedHeadEnd, tailStart);
    const tail = messages.slice(tailStart);

    const summaries = summarizeSlice
      .filter((message) => this.isSummaryMessage(message))
      .map((message) => this.extractSummaryBody(message.content as string))
      .filter((text) => text.length > 0);

    const existingSummary =
      summaries.length > 0 ? summaries.join("\n\n") : null;
    return { head, summarizeSlice, tail, existingSummary };
  }

  private async appendEvent(event: SessionEvent): Promise<void> {
    await this.requireStorage().appendEvent(event);
  }

  private async compactSession(
    sessionId: string,
    initialHistory: ModelMessage[],
    options: CompactOptions,
  ): Promise<void> {
    let history = this.normalizeHistoryForPrompt(initialHistory);
    if (!this.messagesEqual(initialHistory, history)) {
      await this.requireStorage().replaceMessages(sessionId, history);
      await this.appendEvent({
        sessionId,
        type: "history_normalized",
        payload: {
          beforeCount: initialHistory.length,
          afterCount: history.length,
        },
      });
    }

    await this.ensureCanonicalContextSnapshot(sessionId, history);
    const stats = await this.requireStorage().getStats(sessionId);

    const triggerTokens = this.compactionTriggerTokens();
    const initialTokens = this.messageTokens(history);
    if (!options.force && initialTokens < triggerTokens) {
      await this.appendEvent({
        sessionId,
        type: "compaction_skipped",
        payload: {
          mode: options.mode,
          reason: options.reason,
          cause: "below_trigger",
          initialTokens,
          triggerTokens,
        },
      });
      return;
    }

    await this.appendEvent({
      sessionId,
      type: "compaction_started",
      payload: {
        mode: options.mode,
        reason: options.reason,
        initialTokens,
        triggerTokens,
      },
    });

    let passes = 0;

    while (passes < this.maxCompactionPasses) {
      const beforeTokens = this.messageTokens(history);
      if (!options.force && beforeTokens < triggerTokens) {
        return;
      }

      const plan = this.planCompaction(history, stats.canonicalContext);
      if (!plan || plan.summarizeSlice.length === 0) {
        await this.appendEvent({
          sessionId,
          type: "compaction_skipped",
          payload: {
            mode: options.mode,
            reason: options.reason,
            cause: "no_compaction_plan",
            pass: passes + 1,
          },
        });
        return;
      }

      const summary = await summarizeConversation(
        plan.summarizeSlice,
        this.summarizationModel,
        {
          existingSummary: plan.existingSummary,
          reason:
            "Conversation exceeded token budget. Preserve commitments, constraints, and pending tasks.",
        },
      );

      const summaryMessage: ModelMessage = {
        role: "system",
        content: `${SUMMARY_MESSAGE_PREFIX}\n${summary.trim()}`,
      };

      const nextHistory = this.normalizeHistoryForPrompt([
        ...plan.head,
        summaryMessage,
        ...plan.tail,
      ]);
      const afterTokens = this.messageTokens(nextHistory);

      // Abort if compaction does not reduce prompt size.
      if (afterTokens >= beforeTokens) {
        await this.appendEvent({
          sessionId,
          type: "compaction_skipped",
          payload: {
            mode: options.mode,
            reason: options.reason,
            cause: "no_token_reduction",
            pass: passes + 1,
            beforeTokens,
            afterTokens,
          },
        });
        return;
      }

      await this.requireStorage().replaceMessages(sessionId, nextHistory);
      history = nextHistory;
      passes += 1;
      await this.requireStorage().updateStats(sessionId, {
        compactionCount: stats.compactionCount + passes,
        lastCompactionTokensBefore: beforeTokens,
        lastCompactionTokensAfter: afterTokens,
        lastCompactionReason: options.reason,
      });

      const diagnostic: CompactionEvent = {
        sessionId,
        mode: options.mode,
        reason: options.reason,
        pass: passes,
        beforeTokens,
        afterTokens,
        triggerTokens,
        targetTokens: this.targetTokensAfterCompaction,
        summarizedMessages: plan.summarizeSlice.length,
        keptMessages: plan.head.length + plan.tail.length,
      };
      this.onCompactionEvent?.(diagnostic);
      await this.appendEvent({
        sessionId,
        type: "compaction_applied",
        payload: diagnostic as unknown as Record<string, unknown>,
      });

      if (afterTokens <= this.targetTokensAfterCompaction) {
        return;
      }

      const lastUserBoundary = this.lastUserBoundaryIndex(history);
      if (lastUserBoundary === null) {
        return;
      }
    }
  }

  /**
   * Clears the chat history for a session.
   */
  async clearSession(sessionId: string): Promise<void> {
    await this.ensureReady();
    await this.requireStorage().clearSession(sessionId);
    await this.appendEvent({
      sessionId,
      type: "session_cleared",
      payload: {},
    });
  }

  /**
   * Closes the database connection.
   */
  async dispose(): Promise<void> {
    await this.ensureReady();
    await this.requireStorage().dispose();
  }
}
