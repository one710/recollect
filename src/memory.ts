import "dotenv/config";
import sqlite3 from "sqlite3";
import type { LanguageModel, ModelMessage } from "ai";
import { countMessagesTokens } from "./tokenizer.js";
import { summarizeConversation } from "./summarizer.js";

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
   * Optional database path. Defaults to DATABASE_URL env var or 'dev.db'.
   */
  databasePath?: string;
  /**
   * Optional custom token counter function.
   */
  countTokens?: (text: string) => number;
}

export class MemoryLayer {
  private db: sqlite3.Database;
  private maxTokens: number;
  private summarizationModel: LanguageModel;
  private threshold: number;
  private customCountTokens?: ((text: string) => number) | undefined;

  constructor(options: MemoryLayerOptions) {
    const path =
      options.databasePath ||
      process.env.DATABASE_URL?.replace("file:", "") ||
      "dev.db";
    this.db = new sqlite3.Database(path);

    this.initSchema();

    this.maxTokens = options.maxTokens;
    this.summarizationModel = options.summarizationModel;
    this.threshold = options.threshold ?? 0.9;
    this.customCountTokens = options.countTokens;
  }

  private initSchema(): void {
    this.db.serialize(() => {
      // Initialize schema with 'data' column for full AI SDK message objects
      this.db.run(`
                CREATE TABLE IF NOT EXISTS messages (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    sessionId TEXT NOT NULL,
                    role TEXT NOT NULL,
                    content TEXT NOT NULL,
                    data TEXT,
                    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
                );
            `);
      this.db.run(`
                CREATE INDEX IF NOT EXISTS idx_session_id ON messages(sessionId);
            `);

      // Migration: Add 'data' column if it doesn't exist (for existing databases)
      this.db.all("PRAGMA table_info(messages)", (err, rows: any[]) => {
        if (err) return;
        const hasDataColumn = rows.some((col) => col.name === "data");
        if (!hasDataColumn) {
          this.db.run("ALTER TABLE messages ADD COLUMN data TEXT");
        }
      });
    });
  }

  private run(sql: string, params: any[] = []): Promise<void> {
    return new Promise((resolve, reject) => {
      this.db.run(sql, params, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  private all<T>(sql: string, params: any[] = []): Promise<T[]> {
    return new Promise((resolve, reject) => {
      this.db.all(sql, params, (err, rows) => {
        if (err) reject(err);
        else resolve(rows as T[]);
      });
    });
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

    // Store the new message
    await this.run(
      "INSERT INTO messages (sessionId, role, content, data) VALUES (?, ?, ?, ?)",
      [
        sessionId,
        message.role,
        typeof message.content === "string"
          ? message.content
          : JSON.stringify(message.content),
        JSON.stringify(message),
      ],
    );

    // Fetch the current session history
    const history = await this.getMessages(sessionId);

    // Calculate tokens
    const tokenCount = countMessagesTokens(history, this.customCountTokens);

    // Check if threshold is reached
    if (tokenCount >= this.maxTokens * this.threshold) {
      await this.performSummarization(sessionId, history);
    }
  }

  /**
   * Fetches the current chat history for a session.
   */
  async getMessages(sessionId: string): Promise<ModelMessage[]> {
    const rows = await this.all<{
      role: string;
      content: string;
      data: string | null;
    }>(
      "SELECT role, content, data FROM messages WHERE sessionId = ? ORDER BY createdAt ASC",
      [sessionId],
    );

    return rows.map((m) => {
      if (m.data) {
        return JSON.parse(m.data) as ModelMessage;
      }
      // Backward compatibility for rows without 'data' column populated
      return {
        role: m.role as any,
        content: m.content as any,
      } as ModelMessage;
    });
  }

  /**
   * Summarizes the entire conversation history for a session and replaces it with a system summary.
   */
  private async performSummarization(
    sessionId: string,
    history: ModelMessage[],
  ): Promise<void> {
    const summary = await summarizeConversation(
      history,
      this.summarizationModel,
    );

    // Delete all existing messages for this session
    await this.run("DELETE FROM messages WHERE sessionId = ?", [sessionId]);

    // Insert the summary as a system message
    const summaryMessage: ModelMessage = {
      role: "system",
      content: `Conversation Summary: ${summary}`,
    };

    await this.run(
      "INSERT INTO messages (sessionId, role, content, data) VALUES (?, ?, ?, ?)",
      [
        sessionId,
        summaryMessage.role,
        summaryMessage.content as string,
        JSON.stringify(summaryMessage),
      ],
    );
  }

  /**
   * Clears the chat history for a session.
   */
  async clearSession(sessionId: string): Promise<void> {
    await this.run("DELETE FROM messages WHERE sessionId = ?", [sessionId]);
  }

  /**
   * Closes the database connection.
   */
  async dispose(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.db.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }
}
