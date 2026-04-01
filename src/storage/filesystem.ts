import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { jsonl } from "js-jsonl";
import { InMemoryStorageAdapter } from "./in-memory.js";
import type {
  MessageRecord,
  SessionEvent,
  SessionStats,
} from "./types.js";

const MESSAGES_FILE = "messages.jsonl";
const EVENTS_FILE = "events.jsonl";
const STATS_FILE = "stats.json";

function sessionDirName(sessionId: string): string {
  return encodeURIComponent(sessionId);
}

export class FilesystemStorageAdapter extends InMemoryStorageAdapter {
  constructor(private readonly rootDir: string) {
    super();
  }

  private sessionPath(sessionId: string): string {
    return path.join(this.rootDir, sessionDirName(sessionId));
  }

  async init(): Promise<void> {
    await mkdir(this.rootDir, { recursive: true });
    const entries = await readdir(this.rootDir, { withFileTypes: true });
    let maxEventId = 0;

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const sessionId = decodeURIComponent(entry.name);
      const dir = path.join(this.rootDir, entry.name);

      const messagesPath = path.join(dir, MESSAGES_FILE);
      try {
        const raw = await readFile(messagesPath, "utf8");
        const rows = jsonl.parse(raw) as { runId: string | null; data: Record<string, any> }[];
        const records: MessageRecord[] = rows.map((row) => ({
          runId: row.runId ?? null,
          data: row.data,
        }));
        if (records.length > 0) {
          this.sessions.set(sessionId, records);
        }
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }

      const eventsPath = path.join(dir, EVENTS_FILE);
      try {
        const raw = await readFile(eventsPath, "utf8");
        const parsed = jsonl.parse(raw) as SessionEvent[];
        const sorted = [...parsed].sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
        for (const ev of sorted) {
          if (typeof ev.id === "number" && ev.id > maxEventId) {
            maxEventId = ev.id;
          }
        }
        if (sorted.length > 0) {
          this.events.set(sessionId, sorted);
        }
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }

      const statsPath = path.join(dir, STATS_FILE);
      try {
        const raw = await readFile(statsPath, "utf8");
        const stats = JSON.parse(raw) as SessionStats;
        this.stats.set(sessionId, stats);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
    }

    this.nextEventId = maxEventId + 1;
  }

  private async persistMessages(sessionId: string): Promise<void> {
    const dir = this.sessionPath(sessionId);
    await mkdir(dir, { recursive: true });
    const records = this.sessions.get(sessionId) ?? [];
    const lines = records.map((r) => ({ runId: r.runId, data: r.data }));
    const body = lines.length > 0 ? jsonl.stringify(lines) : "";
    await writeFile(path.join(dir, MESSAGES_FILE), body, "utf8");
  }

  private async persistEvents(sessionId: string): Promise<void> {
    const dir = this.sessionPath(sessionId);
    await mkdir(dir, { recursive: true });
    const list = this.events.get(sessionId) ?? [];
    const body = list.length > 0 ? jsonl.stringify(list) : "";
    await writeFile(path.join(dir, EVENTS_FILE), body, "utf8");
  }

  private async persistStats(sessionId: string): Promise<void> {
    const dir = this.sessionPath(sessionId);
    await mkdir(dir, { recursive: true });
    const stats = this.stats.get(sessionId);
    if (!stats) {
      await writeFile(path.join(dir, STATS_FILE), "{}", "utf8");
      return;
    }
    await writeFile(
      path.join(dir, STATS_FILE),
      JSON.stringify(stats),
      "utf8",
    );
  }

  async appendMessage(
    sessionId: string,
    runId: string | null,
    message: Record<string, any>,
  ): Promise<void> {
    await super.appendMessage(sessionId, runId, message);
    await this.persistMessages(sessionId);
  }

  async replaceMessages(
    sessionId: string,
    records: MessageRecord[],
  ): Promise<void> {
    await super.replaceMessages(sessionId, records);
    await this.persistMessages(sessionId);
  }

  async clearSession(sessionId: string): Promise<void> {
    await super.clearSession(sessionId);
    await this.persistMessages(sessionId);
  }

  async appendEvent(event: SessionEvent): Promise<void> {
    await super.appendEvent(event);
    await this.persistEvents(event.sessionId);
  }

  async updateStats(
    sessionId: string,
    patch: Partial<SessionStats>,
  ): Promise<void> {
    await super.updateStats(sessionId, patch);
    await this.persistStats(sessionId);
  }
}
