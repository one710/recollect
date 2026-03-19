import {
  summarizeConversation,
  type SummarizeCallable,
  type MessageRenderer,
  SUMMARY_MESSAGE_PREFIX,
} from "./summarizer.js";
import {
  createSQLiteStorageAdapter,
  type MessageRecord,
  type MemoryStorageAdapter,
  type SessionEvent,
  type SessionStats,
} from "./storage.js";

const DEFAULT_THRESHOLD = 0.9;
const DEFAULT_TARGET_TOKENS_FACTOR = 0.65;
const DEFAULT_KEEP_RECENT_USER_TURNS = 4;
const DEFAULT_KEEP_RECENT_MESSAGES_MIN = 8;
const DEFAULT_MAX_COMPACTION_PASSES = 3;
const DEFAULT_MINIMUM_MESSAGES_TO_COMPACT = 6;

export type TokenCounter = (message: Record<string, any>) => number;
export type CompactionEventHandler = (event: CompactionEvent) => void;

export interface MemoryLayerOptions {
  /**
   * Maximum tokens allowed in the chat history before summarization is triggered.
   */
  maxTokens: number;
  /**
   * Callback that generates a summary from rendered transcript text.
   */
  summarize: SummarizeCallable;
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
   * Custom token counter function.
   * Now mandatory and accepts the entire message object.
   */
  countTokens: TokenCounter;
  /**
   * Optional callback to render a message as text for summarization.
   * Defaults to JSON.stringify(message).
   */
  renderMessage?: MessageRenderer;
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
  onCompactionEvent?: CompactionEventHandler;
  /**
   * The role to use for summary messages.
   * Defaults to 'system'.
   */
  summaryRole?: string;
}

interface CompactionPlan {
  head: MessageRecord[];
  summarizeSlice: MessageRecord[];
  tail: MessageRecord[];
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
  messages: Record<string, any>[];
  tokenCount: number;
  stats: SessionStats;
}

interface CompactOptions {
  mode: CompactionMode;
  reason: string;
  force: boolean;
  /** When set, messages with this runId are never summarized (current run stays as tail). */
  currentRunId?: string | null;
  /** Public API: same as currentRunId (pass runId in options; we set currentRunId for compactSession). */
  runId?: string | null;
}

export class MemoryLayer {
  private storage: MemoryStorageAdapter | null;
  private storageReady: Promise<void>;
  private maxTokens: number;
  private summarize: SummarizeCallable;
  private threshold: number;
  private countTokens: TokenCounter;
  private renderMessage: MessageRenderer | undefined;
  // @ts-ignore - targetTokensAfterCompaction is used but marked as unused in some contexts
  private targetTokensAfterCompaction: number;
  private keepRecentUserTurns: number;
  private keepRecentMessagesMin: number;
  private maxCompactionPasses: number;
  private minimumMessagesToCompact: number;
  private onCompactionEvent: CompactionEventHandler | undefined;
  private summaryRole: string;

  constructor(options: MemoryLayerOptions) {
    this.storage = options.storage ?? null;
    this.storageReady = this.initializeStorage(options);

    this.maxTokens = options.maxTokens;
    this.summarize = options.summarize;
    this.threshold = options.threshold ?? DEFAULT_THRESHOLD;
    this.countTokens = options.countTokens;
    this.renderMessage = options.renderMessage;
    this.targetTokensAfterCompaction =
      options.targetTokensAfterCompaction ??
      Math.max(1, Math.floor(this.maxTokens * DEFAULT_TARGET_TOKENS_FACTOR));
    this.keepRecentUserTurns = Math.max(
      1,
      options.keepRecentUserTurns ?? DEFAULT_KEEP_RECENT_USER_TURNS,
    );
    this.keepRecentMessagesMin = Math.max(
      1,
      options.keepRecentMessagesMin ?? DEFAULT_KEEP_RECENT_MESSAGES_MIN,
    );
    this.maxCompactionPasses = Math.max(
      1,
      options.maxCompactionPasses ?? DEFAULT_MAX_COMPACTION_PASSES,
    );
    this.minimumMessagesToCompact = Math.max(
      2,
      options.minimumMessagesToCompact ?? DEFAULT_MINIMUM_MESSAGES_TO_COMPACT,
    );
    this.onCompactionEvent = options.onCompactionEvent;
    this.summaryRole = options.summaryRole ?? "system";
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
   * @param runId Optional. When provided, the message is tagged with this run; compaction will never summarize the current run's messages.
   */
  async addMessage(
    sessionId: string,
    runId: string | null,
    message: Record<string, any>,
  ): Promise<void> {
    await this.ensureReady();
    await this.appendAndMaybeCompact(
      sessionId,
      runId,
      [message],
      "message_appended",
      {
        role: message.role,
      },
    );
  }

  /**
   * Legacy addMessage for backward compatibility (optional but recommended to keep briefly or remove)
   * I'll move to the new signature as requested: "people could just provide a dict ... remove the type totally"
   */

  /**
   * Adds multiple messages in order and triggers compaction if needed.
   * @param runId Optional. When provided, all messages are tagged with this run; compaction will never summarize this run's messages (avoids splitting tool_use/tool_result pairs).
   */
  async addMessages(
    sessionId: string,
    runId: string | null,
    messages: Record<string, any>[],
  ): Promise<void> {
    await this.ensureReady();
    await this.appendAndMaybeCompact(
      sessionId,
      runId,
      messages,
      "messages_appended",
      {
        count: messages.length,
      },
    );
  }

  /**
   * Returns the persisted memory for this session (suitable as model prompt).
   */
  async getPromptMessages(sessionId: string): Promise<Record<string, any>[]> {
    return this.getMessages(sessionId, null);
  }

  /**
   * Fetches the current chat history for a session.
   * @param runId Optional. Reserved for future use (e.g. filtering by run); currently unused.
   */
  async getMessages(
    sessionId: string,
    _runIdParam: string | null = null,
  ): Promise<Record<string, any>[]> {
    await this.ensureReady();
    const records = await this.requireStorage().listMessages(sessionId);
    return this.recordsToMessages(records);
  }

  /**
   * Forces one compaction cycle for a session.
   * @param runId Optional. When provided, messages tagged with this run are kept as tail (not summarized).
   */
  async compactNow(
    sessionId: string,
    runId: string | null = null,
  ): Promise<void> {
    await this.compactIfNeeded(sessionId, {
      mode: "manual",
      reason: "manual_compact_now",
      force: true,
      ...(runId != null ? { runId } : {}),
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
      ...(options.runId != null || options.currentRunId != null
        ? { currentRunId: options.runId ?? options.currentRunId ?? null }
        : {}),
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
    const records = await this.requireStorage().listMessages(sessionId);
    const messages = this.recordsToMessages(records);
    const tokenCount = this.messageTokens(messages);
    const stats = await this.requireStorage().getStats(sessionId);
    return { messages, tokenCount, stats };
  }

  private compactionTriggerTokens(): number {
    return Math.max(1, Math.floor(this.maxTokens * this.threshold));
  }

  private messageTokens(messages: Record<string, any>[]): number {
    return messages.reduce((acc, m) => acc + this.countTokens(m), 0);
  }

  private isPinnedInstructionRole(message: Record<string, any>): boolean {
    return (
      (message.role === "system" || message.role === "developer") &&
      !this.isSummaryMessage(message)
    );
  }

  private isSummaryMessage(message: Record<string, any>): boolean {
    return (
      message.role === this.summaryRole &&
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

  private leadingCanonicalContext(
    messages: Record<string, any>[],
  ): Record<string, any>[] {
    let idx = 0;
    while (
      idx < messages.length &&
      this.isPinnedInstructionRole(messages[idx]!)
    ) {
      idx += 1;
    }
    return messages.slice(0, idx);
  }

  private recordsToMessages(records: MessageRecord[]): Record<string, any>[] {
    return records.map((record) => record.data);
  }

  private async ensureCanonicalContextSnapshot(
    sessionId: string,
    history: Record<string, any>[],
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

  private async appendAndMaybeCompact(
    sessionId: string,
    runId: string | null,
    messages: Record<string, any>[],
    eventType: SessionEvent["type"],
    payload: Record<string, unknown>,
  ): Promise<void> {
    for (const message of messages) {
      await this.requireStorage().appendMessage(sessionId, runId, message);
    }
    await this.appendEvent({
      sessionId,
      type: eventType,
      payload,
    });

    const history = await this.requireStorage().listMessages(sessionId);
    const historyMessages = this.recordsToMessages(history);
    await this.ensureCanonicalContextSnapshot(sessionId, historyMessages);
    const tokenCount = this.messageTokens(historyMessages);
    if (tokenCount < this.compactionTriggerTokens()) {
      return;
    }
    await this.compactSession(sessionId, history, {
      mode: "ingest",
      reason:
        messages.length === 1
          ? "threshold_reached_after_add_message"
          : "threshold_reached_after_add_messages",
      force: false,
      ...(runId != null ? { currentRunId: runId } : {}),
    });
  }

  private planCompaction(
    records: MessageRecord[],
    canonicalContext: Record<string, any>[] | null,
    currentRunId?: string | null,
  ): CompactionPlan | null {
    if (records.length < this.minimumMessagesToCompact) {
      return null;
    }
    const messages = this.recordsToMessages(records);

    // Preserve initial instruction messages verbatim.
    const fallbackHead = this.leadingCanonicalContext(messages);
    const head =
      canonicalContext && canonicalContext.length > 0
        ? canonicalContext
        : fallbackHead;

    let pinnedHeadEnd = fallbackHead.length;
    while (
      pinnedHeadEnd < messages.length &&
      this.isPinnedInstructionRole(messages[pinnedHeadEnd]!)
    ) {
      pinnedHeadEnd += 1;
    }

    let tailStart: number;

    if (currentRunId != null) {
      // Run-scoped compaction: keep all messages of the current run as tail (never summarize).
      const firstCurrentRunIndex = records.findIndex(
        (record) => record.runId === currentRunId,
      );
      if (firstCurrentRunIndex >= pinnedHeadEnd) {
        tailStart = firstCurrentRunIndex;
      } else {
        // No message with this runId (e.g. legacy session); fall back to default tail.
        tailStart = this.computeDefaultTailStart(messages, pinnedHeadEnd);
      }
    } else {
      tailStart = this.computeDefaultTailStart(messages, pinnedHeadEnd);
    }

    if (tailStart <= pinnedHeadEnd) {
      return null;
    }

    const summarizeSlice = records.slice(pinnedHeadEnd, tailStart);
    const tail = records.slice(tailStart);

    const summaries = summarizeSlice
      .map((record) => record.data)
      .filter((message) => this.isSummaryMessage(message))
      .map((message) => this.extractSummaryBody(message.content as string))
      .filter((text) => text.length > 0);

    const existingSummary =
      summaries.length > 0 ? summaries.join("\n\n") : null;
    const headRecords: MessageRecord[] = head.map((message) => ({
      data: message,
      runId: null,
    }));
    return { head: headRecords, summarizeSlice, tail, existingSummary };
  }

  private computeDefaultTailStart(
    messages: Record<string, any>[],
    pinnedHeadEnd: number,
  ): number {
    const userBoundaries: number[] = [];
    for (let i = pinnedHeadEnd; i < messages.length; i += 1) {
      if (messages[i]?.role === "user") {
        userBoundaries.push(i);
      }
    }
    if (userBoundaries.length > this.keepRecentUserTurns) {
      return userBoundaries[userBoundaries.length - this.keepRecentUserTurns]!;
    }
    return Math.max(
      pinnedHeadEnd + 1,
      messages.length - this.keepRecentMessagesMin,
    );
  }

  private async appendEvent(event: SessionEvent): Promise<void> {
    await this.requireStorage().appendEvent(event);
  }

  private async compactSession(
    sessionId: string,
    initialHistory: MessageRecord[],
    options: CompactOptions,
  ): Promise<void> {
    let history = initialHistory;
    let historyMessages = this.recordsToMessages(history);

    await this.ensureCanonicalContextSnapshot(sessionId, historyMessages);
    const stats = await this.requireStorage().getStats(sessionId);

    const triggerTokens = this.compactionTriggerTokens();
    const initialTokens = this.messageTokens(historyMessages);
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
      const beforeTokens = this.messageTokens(historyMessages);
      if (!options.force && beforeTokens < triggerTokens) {
        return;
      }

      const plan = this.planCompaction(
        history,
        stats.canonicalContext,
        options.currentRunId,
      );
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
        this.recordsToMessages(plan.summarizeSlice),
        this.summarize,
        {
          ...(this.renderMessage ? { renderMessage: this.renderMessage } : {}),
          existingSummary: plan.existingSummary,
          reason:
            "Conversation exceeded token budget. Preserve commitments, constraints, and pending tasks.",
        },
      );

      const summaryMessage: Record<string, any> = {
        role: this.summaryRole,
        content: `${SUMMARY_MESSAGE_PREFIX}\n${summary.trim()}`,
      };

      const nextHistory: MessageRecord[] = [
        ...plan.head,
        { data: summaryMessage, runId: null },
        ...plan.tail,
      ];
      const nextHistoryMessages = this.recordsToMessages(nextHistory);
      const afterTokens = this.messageTokens(nextHistoryMessages);

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
      historyMessages = nextHistoryMessages;
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
