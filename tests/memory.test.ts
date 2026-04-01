import {
  jest,
  describe,
  test,
  expect,
  beforeEach,
  afterEach,
} from "@jest/globals";
import { MemoryLayer } from "../src/memory.js";
import {
  FilesystemStorageAdapter,
  InMemoryStorageAdapter,
  createPostgresStorageAdapter,
  createSQLiteStorageAdapter,
} from "../src/storage.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ADAPTERS = [
  { name: "InMemory", factory: () => new InMemoryStorageAdapter() },
  {
    name: "SQLite",
    factory: async () => {
      const adapter = await createSQLiteStorageAdapter(":memory:");
      await adapter.init();
      return { adapter, dbPath: undefined };
    },
  },
  {
    name: "Filesystem",
    factory: async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "recollect-fs-"));
      const adapter = new FilesystemStorageAdapter(root);
      await adapter.init();
      return { adapter, dbPath: root };
    },
  },
  ...(process.env.RECOLLECT_TEST_PG_URL
    ? [
        {
          name: "Postgres",
          factory: async () => {
            const url = process.env.RECOLLECT_TEST_PG_URL!;
            const adapter = await createPostgresStorageAdapter(url);
            await adapter.init();
            return {
              adapter,
              dbPath: undefined,
              pgTruncate: () => adapter.truncateAllForTesting(),
            };
          },
        },
      ]
    : []),
];

describe.each(ADAPTERS)(
  "MemoryLayer with $name storage",
  ({ name, factory }) => {
    const mockSummarize = jest.fn(async () => "Mocked summary");
    const defaultCountTokens = (m: Record<string, any>) =>
      JSON.stringify(m).length;

    let memory: MemoryLayer;
    let adapter: any;
    let dbPath: string | undefined;
    let pgTruncate: (() => Promise<void>) | undefined;
    const sessionId = "test-session";
    beforeEach(async () => {
      pgTruncate = undefined;
      const created = await factory();
      if ("adapter" in created) {
        adapter = created.adapter;
        dbPath = created.dbPath;
        if ("pgTruncate" in created && created.pgTruncate) {
          pgTruncate = created.pgTruncate;
        }
      } else {
        adapter = created;
        dbPath = undefined;
      }

      memory = new MemoryLayer({
        maxTokens: 5000,
        summarize: mockSummarize,
        countTokens: defaultCountTokens,
        threshold: 0.8,
        storage: adapter,
        keepRecentUserTurns: 1,
        keepRecentMessagesMin: 2,
        minimumMessagesToCompact: 2,
      });
    }, 10000); // 10s for sqlite init

    afterEach(async () => {
      if (pgTruncate) {
        await pgTruncate();
      }
      if (memory) {
        await memory.clearSession(sessionId);
        await memory.dispose();
      }
      if (dbPath && fs.existsSync(dbPath)) {
        try {
          fs.rmSync(dbPath, { recursive: true, force: true });
        } catch (e) {
          // ignore busy
        }
      }
    });

    test("should add messages and retrieve history", async () => {
      await memory.addMessage(sessionId, null, {
        role: "user",
        content: "Hello",
      });
      const history = await memory.getMessages(sessionId);
      expect(history.length).toBe(1);
      expect(history[0]?.role).toBe("user");
      expect(history[0]?.content).toBe("Hello");
    });

    test("should trigger compaction and preserve recent context", async () => {
      await memory.addMessage(sessionId, null, {
        role: "assistant",
        content: "A very long message".repeat(20),
      });
      await memory.addMessage(sessionId, null, {
        role: "user",
        content: "Force compaction now please!".repeat(50),
      });

      await memory.compactNow(sessionId);
      const history = await memory.getMessages(sessionId);

      expect(history.length).toBeGreaterThanOrEqual(2);
      expect(history.some((m) => m.role === "system")).toBe(true);
      expect(
        history.some(
          (m) =>
            m.role === "system" &&
            m.content &&
            typeof m.content === "string" &&
            m.content.includes("Conversation checkpoint summary") &&
            m.content.includes("Mocked summary"),
        ),
      ).toBe(true);
      expect(history.some((m) => m.role === "user")).toBe(true);
    });

    test("clearSession should remove all messages for a session", async () => {
      await memory.addMessage(sessionId, null, {
        role: "user",
        content: "forget me",
      });
      await memory.clearSession(sessionId);
      const history = await memory.getMessages(sessionId);
      expect(history.length).toBe(0);
    });

    test("should use custom countTokens if provided in options", async () => {
      const customSessionId = "custom-tokenizer-" + Date.now();
      const mockCounter = jest
        .fn<(message: Record<string, any>) => number>()
        .mockReturnValue(100);

      // We need a fresh memory with low maxTokens to trigger something easily
      const customMemory = new MemoryLayer({
        maxTokens: 50,
        summarize: mockSummarize,
        countTokens: mockCounter,
        storage: adapter,
        minimumMessagesToCompact: 2,
      });

      const msg = { role: "user", content: "Hello" };
      await customMemory.addMessage(customSessionId, null, msg);
      const history = await customMemory.getMessages(customSessionId);
      expect(history.length).toBeGreaterThanOrEqual(1);
      expect(mockCounter).toHaveBeenCalled();
    });

    test("should preserve tool input strings as-is", async () => {
      const session = "tool-input-string";
      await memory.addMessages(session, null, [
        { role: "user", content: "Run structured tool call" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Calling tool with JSON-string input." },
            {
              type: "tool-call",
              toolCallId: "call-str-input",
              toolName: "structuredTool",
              input: '{"hello":"world","n":1}',
            },
          ],
        },
      ]);

      const prompt = await memory.getPromptMessages(session);
      const assistant = prompt.find((m) => m.role === "assistant");
      const toolPart = (assistant?.content ?? []).find(
        (part: any) =>
          part.type === "tool-call" && part.toolCallId === "call-str-input",
      );
      expect(typeof toolPart?.input).toBe("string");
      expect(toolPart?.input).toBe('{"hello":"world","n":1}');
    });

    test("getPromptMessages should return stored messages unchanged", async () => {
      const session = "prompt-passthrough";
      await memory.addMessages(session, null, [
        { role: "user", content: "Run one tool." },
        {
          role: "tool",
          content: [
            undefined,
            {
              type: "text",
              text: "legacy/invalid tool part that should pass through",
            },
            {
              type: "tool-result",
              toolCallId: "idem-call",
              toolName: "idem",
              result: { ok: true },
            },
          ],
        },
      ]);

      const firstPrompt = await memory.getPromptMessages(session);
      const secondPrompt = await memory.getPromptMessages(session);
      expect(secondPrompt).toEqual(firstPrompt);
    });

    test("should preserve canonical instruction context after compaction", async () => {
      const session = "canonical-context";
      const mem = new MemoryLayer({
        maxTokens: 100,
        threshold: 0.5,
        summarize: mockSummarize,
        countTokens: defaultCountTokens,
        storage: adapter,
        keepRecentUserTurns: 1,
        keepRecentMessagesMin: 2,
        minimumMessagesToCompact: 2,
      });

      await mem.addMessages(session, null, [
        { role: "system", content: "System guardrail A" },
        { role: "developer", content: "Developer instruction B" },
        { role: "user", content: "long user turn".repeat(20) },
        { role: "assistant", content: "long assistant response".repeat(20) },
        { role: "user", content: "another long turn".repeat(20) },
      ]);

      await mem.compactNow(session);
      const prompt = await mem.getPromptMessages(session);
      expect(prompt[0]?.role).toBe("system");
      expect(prompt[1]?.role).toBe("developer");
      expect(prompt[0]?.content).toBe("System guardrail A");
      expect(prompt[1]?.content).toBe("Developer instruction B");
    });

    test("should persist compaction events and stats", async () => {
      const eventSession = "events";
      const mem = new MemoryLayer({
        maxTokens: 100,
        threshold: 0.5,
        summarize: mockSummarize,
        countTokens: defaultCountTokens,
        storage: adapter,
        keepRecentUserTurns: 1,
        keepRecentMessagesMin: 2,
        minimumMessagesToCompact: 2,
      });

      await mem.addMessages(eventSession, null, [
        { role: "system", content: "Guardrail" },
        { role: "user", content: "Instruction A".repeat(10) },
        { role: "assistant", content: "Response A".repeat(10) },
        { role: "user", content: "Instruction B".repeat(10) },
      ]);

      await mem.compactNow(eventSession);
      const snapshot = await mem.getSessionSnapshot(eventSession);
      const events = await mem.getSessionEvents(eventSession, 50);
      expect(snapshot.stats.compactionCount).toBeGreaterThanOrEqual(1);
      expect(events.some((event) => event.type === "compaction_started")).toBe(
        true,
      );
      expect(events.some((event) => event.type === "compaction_applied")).toBe(
        true,
      );
      expect(snapshot.stats.canonicalContext?.[0]?.role).toBe("system");
    });

    test("addMessages appends without implicit dedupe", async () => {
      const session = "append-no-dedupe";
      const canonicalAssistant = {
        role: "assistant",
        content: [
          { type: "text", text: "Calling tool." },
          {
            type: "tool-call",
            toolCallId: "dedupe-call",
            toolName: "dedupeTool",
            input: { q: "x" },
          },
        ],
      };

      await memory.addMessages(session, null, [
        { role: "user", content: "Run dedupe tool" },
        canonicalAssistant,
      ]);

      const incomingPrompt = [
        { role: "user", content: "Run dedupe tool" },
        canonicalAssistant,
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "dedupe-call",
              toolName: "dedupeTool",
              result: { ok: true },
            },
          ],
        },
      ];

      await memory.addMessages(session, null, incomingPrompt);
      const all = await memory.getMessages(session);

      const userCount = all.filter((m) => m.role === "user").length;
      const assistantCount = all.filter((m) => m.role === "assistant").length;
      expect(userCount).toBe(2);
      expect(assistantCount).toBe(2);
    });

    test("should preserve malformed tool-role content parts as-is", async () => {
      const session = "malformed-tool";
      await memory.addMessages(session, null, [
        { role: "user", content: "Run tool once" },
        {
          role: "assistant",
          content: "Calling tool",
          toolCalls: [
            {
              type: "tool-call",
              toolCallId: "sanitize-call",
              toolName: "sanitizerTool",
              args: {},
            },
          ],
        },
        {
          role: "tool",
          content: [
            null,
            { type: "text", text: "not valid for tool role" },
            {
              type: "tool-result",
              toolCallId: "sanitize-call",
              toolName: "sanitizerTool",
              output: { type: "json", value: { ok: true } },
            },
          ],
        },
      ]);

      const prompt = await memory.getPromptMessages(session);
      const toolMessages = prompt.filter((m) => m.role === "tool");
      expect(toolMessages[0]?.content).toEqual([
        null,
        { type: "text", text: "not valid for tool role" },
        {
          type: "tool-result",
          toolCallId: "sanitize-call",
          toolName: "sanitizerTool",
          output: { type: "json", value: { ok: true } },
        },
      ]);
    });

    test("should handle completely custom message dicts", async () => {
      const session = "custom-dict";
      const customCountTokens = (m: Record<string, any>) => (m.foo ? 100 : 1);
      const mem = new MemoryLayer({
        maxTokens: 50,
        summarize: async () => "summary of custom",
        countTokens: customCountTokens,
        storage: adapter,
        minimumMessagesToCompact: 2,
      });

      await mem.addMessage(session, null, {
        role: "system",
        content: "start",
      });
      await mem.addMessage(session, null, {
        foo: "This is heavy",
        role: "user",
      });

      const history = await mem.getMessages(session);
      expect(
        history.some(
          (m) =>
            m.role === "system" &&
            m.content &&
            (m.content as string).includes("summary of custom"),
        ),
      ).toBe(true);
    });

    test("should handle completely custom renderMessage", async () => {
      const session = "custom-render";
      const mockRender = jest.fn(
        (m: Record<string, any>) => `RENDERED:${m.text}`,
      );
      const mem = new MemoryLayer({
        maxTokens: 50,
        summarize: async (req) => {
          if (req.summaryPrompt.includes("RENDERED:Heavy")) {
            return "captured heavy";
          }
          return "not captured";
        },
        countTokens: (m) => (m.text === "Heavy" ? 100 : 1),
        renderMessage: mockRender,
        storage: adapter,
        minimumMessagesToCompact: 2,
      });

      await mem.addMessage(session, null, { role: "system", text: "start" });
      await mem.addMessage(session, null, { text: "Heavy", role: "user" });

      const history = await mem.getMessages(session);
      expect(
        history.some(
          (m) =>
            m.role === "system" &&
            m.content &&
            (m.content as string).includes("captured heavy"),
        ),
      ).toBe(true);
      expect(mockRender).toHaveBeenCalled();
    });

    test("should use custom summaryRole if provided", async () => {
      const session = "custom-summary-role";
      const mem = new MemoryLayer({
        maxTokens: 100,
        summarize: async () => "summary with custom role",
        countTokens: (m) => JSON.stringify(m).length,
        storage: adapter,
        summaryRole: "developer",
        minimumMessagesToCompact: 1,
        keepRecentMessagesMin: 0,
        keepRecentUserTurns: 0,
      });

      await mem.addMessage(session, null, {
        role: "user",
        content: "trigger summary PART 1".repeat(10),
      });
      await mem.addMessage(session, null, {
        role: "user",
        content: "trigger summary PART 2".repeat(10),
      });
      await mem.compactNow(session);

      const history = await mem.getMessages(session);
      expect(
        history.some(
          (m) =>
            m.role === "developer" &&
            m.content &&
            (m.content as string).includes("summary with custom role"),
        ),
      ).toBe(true);
    });
  },
);

describe("FilesystemStorageAdapter persistence", () => {
  test("reloads messages and stats from disk after dispose and new adapter", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "recollect-fs-reload-"));
    try {
      const first = new FilesystemStorageAdapter(root);
      await first.init();
      await first.appendMessage("reload-session", null, {
        role: "user",
        content: "persisted",
      });
      await first.updateStats("reload-session", { compactionCount: 2 });
      await first.dispose();

      const second = new FilesystemStorageAdapter(root);
      await second.init();
      const msgs = await second.listMessages("reload-session");
      expect(msgs.length).toBe(1);
      expect(msgs[0]?.data.content).toBe("persisted");
      const st = await second.getStats("reload-session");
      expect(st.compactionCount).toBe(2);
      await second.dispose();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
