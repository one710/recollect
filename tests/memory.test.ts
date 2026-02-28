import {
  jest,
  describe,
  test,
  expect,
  beforeAll,
  afterAll,
} from "@jest/globals";
import { MemoryLayer } from "../src/memory.js";
import { InMemoryStorageAdapter } from "../src/storage.js";

describe("MemoryLayer", () => {
  const mockModel: any = {
    specificationVersion: "v3",
    modelId: "mock-model",
    provider: "mock-provider",
    doGenerate: jest.fn<any>().mockResolvedValue({
      text: "Mocked summary",
      content: [{ type: "text", text: "Mocked summary" }],
      finishReason: "stop",
      usage: {
        inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 5, text: 5, reasoning: 0 },
      },
      warnings: [],
      rawCall: { rawPrompt: "...", rawSettings: {} },
    }),
  };

  let memory: MemoryLayer;
  const sessionId = "test-session-" + Date.now();

  beforeAll(async () => {
    memory = new MemoryLayer({
      maxTokens: 50,
      summarizationModel: mockModel,
      threshold: 0.5,
      storage: new InMemoryStorageAdapter(),
      keepRecentUserTurns: 1,
      keepRecentMessagesMin: 2,
      minimumMessagesToCompact: 2,
    });
  });

  afterAll(async () => {
    await memory.clearSession(sessionId);
    await memory.dispose();
  });

  test("should add messages and retrieve history", async () => {
    await memory.addMessage(sessionId, "user", "Hello");
    const history = await memory.getMessages(sessionId);
    expect(history.length).toBe(1);
    expect(history[0]?.role).toBe("user");
    expect(history[0]?.content).toBe("Hello");
  });

  test("should trigger compaction and preserve recent context", async () => {
    await memory.addMessage(
      sessionId,
      "assistant",
      "This is a longer message that should significantly increase the token count for this session.",
    );
    await memory.addMessage(
      sessionId,
      "user",
      "And another message to be absolutely sure we cross the threshold.",
    );

    const history = await memory.getMessages(sessionId);

    expect(history.length).toBeGreaterThanOrEqual(2);
    expect(history.some((m) => m.role === "system")).toBe(true);
    expect(
      history.some(
        (m) =>
          m.role === "system" &&
          typeof m.content === "string" &&
          m.content.includes("Conversation checkpoint summary") &&
          m.content.includes("Mocked summary"),
      ),
    ).toBe(true);
    expect(history.some((m) => m.role === "user")).toBe(true);
  });

  test("clearSession should remove all messages for a session", async () => {
    await memory.clearSession(sessionId);
    const history = await memory.getMessages(sessionId);
    expect(history.length).toBe(0);
  });

  test("should use custom countTokens if provided in options", async () => {
    const customSessionId = "custom-tokenizer-" + Date.now();
    const mockCounter = jest
      .fn<(text: string) => number>()
      .mockReturnValue(100);
    const customMemory = new MemoryLayer({
      maxTokens: 50,
      summarizationModel: mockModel,
      countTokens: mockCounter,
      storage: new InMemoryStorageAdapter(),
      minimumMessagesToCompact: 2,
    });

    await customMemory.addMessage(customSessionId, "user", "Hello");
    // Custom counter should be used during token accounting.
    const history = await customMemory.getMessages(customSessionId);
    expect(history.length).toBeGreaterThanOrEqual(1);
    expect(history[0]?.role).toBe("user");
    expect(mockCounter).toHaveBeenCalledWith("Hello");

    await customMemory.dispose();
  });

  test("should support in-memory storage adapter", async () => {
    const inMemorySession = "in-memory-" + Date.now();
    const inMemory = new MemoryLayer({
      maxTokens: 100,
      summarizationModel: mockModel,
      storage: new InMemoryStorageAdapter(),
    });

    await inMemory.addMessage(inMemorySession, "user", "hello in-memory");
    await inMemory.addMessage(inMemorySession, "assistant", "ack");
    const history = await inMemory.getMessages(inMemorySession);
    expect(history.length).toBe(2);
    expect(history[0]?.role).toBe("user");
    expect(history[1]?.role).toBe("assistant");

    await inMemory.dispose();
  });

  test("should normalize orphan tool results in prompt view", async () => {
    const orphanSession = "orphan-tools-" + Date.now();
    const mem = new MemoryLayer({
      maxTokens: 1000,
      summarizationModel: mockModel,
      storage: new InMemoryStorageAdapter(),
    });

    await mem.addMessages(orphanSession, [
      { role: "user", content: "Run diagnostics" } as any,
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "missing-call",
            toolName: "diagnose",
            result: { ok: false },
          },
        ],
      } as any,
    ]);

    const prompt = await mem.getPromptMessages(orphanSession);
    expect(
      prompt.some(
        (msg: any) =>
          msg.role === "tool" &&
          Array.isArray(msg.content) &&
          msg.content.some((p: any) => p.toolCallId === "missing-call"),
      ),
    ).toBe(false);

    await mem.dispose();
  });

  test("should recognize tool calls encoded in assistant content parts", async () => {
    const session = "tool-call-content-part-" + Date.now();
    const mem = new MemoryLayer({
      maxTokens: 1000,
      summarizationModel: mockModel,
      storage: new InMemoryStorageAdapter(),
    });

    await mem.addMessages(session, [
      { role: "user", content: "Please run diagnostics" } as any,
      {
        role: "assistant",
        content: [
          { type: "text", text: "Calling diagnostic tool." },
          {
            type: "tool-call",
            toolCallId: "call-content-1",
            toolName: "diagnose",
            args: { deep: true },
          },
        ],
      } as any,
    ]);

    const prompt = await mem.getPromptMessages(session);
    expect(
      prompt.some(
        (msg: any) =>
          msg.role === "tool" &&
          Array.isArray(msg.content) &&
          msg.content.some(
            (part: any) =>
              part.type === "tool-result" &&
              part.toolCallId === "call-content-1" &&
              part.result?.status === "missing_result",
          ),
      ),
    ).toBe(true);

    await mem.dispose();
  });

  test("should not synthesize missing results when assistant content already has tool-result", async () => {
    const session = "assistant-tool-result-content-part-" + Date.now();
    const mem = new MemoryLayer({
      maxTokens: 1000,
      summarizationModel: mockModel,
      storage: new InMemoryStorageAdapter(),
    });

    await mem.addMessages(session, [
      { role: "user", content: "Run diagnostics and show result." } as any,
      {
        role: "assistant",
        content: [
          { type: "text", text: "Tool call + inline result." },
          {
            type: "tool-call",
            toolCallId: "call-inline-1",
            toolName: "diagnose",
            args: { deep: true },
          },
          {
            type: "tool-result",
            toolCallId: "call-inline-1",
            toolName: "diagnose",
            result: { ok: true },
          },
        ],
      } as any,
    ]);

    const prompt = await mem.getPromptMessages(session);
    expect(
      prompt.some(
        (msg: any) =>
          msg.role === "tool" &&
          Array.isArray(msg.content) &&
          msg.content.some(
            (part: any) =>
              part.type === "tool-result" &&
              part.toolCallId === "call-inline-1" &&
              part.result?.status === "missing_result",
          ),
      ),
    ).toBe(false);

    await mem.dispose();
  });

  test("should synthesize only unresolved results across multiple tool calls", async () => {
    const session = "multi-tool-partial-results-" + Date.now();
    const mem = new MemoryLayer({
      maxTokens: 1000,
      summarizationModel: mockModel,
      storage: new InMemoryStorageAdapter(),
    });

    await mem.addMessages(session, [
      { role: "user", content: "Run two tools." } as any,
      {
        role: "assistant",
        content: "Running now.",
        toolCalls: [
          {
            type: "tool-call",
            toolCallId: "call-a",
            toolName: "toolA",
            args: { x: 1 },
          },
          {
            type: "tool-call",
            toolCallId: "call-b",
            toolName: "toolB",
            args: { y: 2 },
          },
        ],
      } as any,
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-a",
            toolName: "toolA",
            result: { ok: true },
          },
        ],
      } as any,
    ]);

    const prompt = await mem.getPromptMessages(session);
    const toolMsgs = prompt.filter((msg: any) => msg.role === "tool");
    const allParts = toolMsgs.flatMap((msg: any) =>
      Array.isArray(msg.content) ? msg.content : [],
    );
    const missing = allParts.filter(
      (part: any) =>
        part.type === "tool-result" && part.result?.status === "missing_result",
    );
    expect(missing.length).toBe(1);
    expect(missing[0]?.toolCallId).toBe("call-b");

    await mem.dispose();
  });

  test("normalization should be idempotent", async () => {
    const session = "normalization-idempotent-" + Date.now();
    const mem = new MemoryLayer({
      maxTokens: 1000,
      summarizationModel: mockModel,
      storage: new InMemoryStorageAdapter(),
    });

    await mem.addMessages(session, [
      { role: "user", content: "Run one tool." } as any,
      {
        role: "assistant",
        content: "Calling tool",
        toolCalls: [
          {
            type: "tool-call",
            toolCallId: "idem-call",
            toolName: "idem",
            args: {},
          },
        ],
      } as any,
    ]);

    const firstPrompt = await mem.getPromptMessages(session);
    const secondPrompt = await mem.getPromptMessages(session);
    expect(secondPrompt).toEqual(firstPrompt);
    expect(firstPrompt.filter((msg: any) => msg.role === "tool").length).toBe(
      1,
    );

    await mem.dispose();
  });

  test("should preserve canonical instruction context after compaction", async () => {
    const session = "canonical-context-preserved-" + Date.now();
    const mem = new MemoryLayer({
      maxTokens: 60,
      threshold: 0.5,
      summarizationModel: mockModel,
      storage: new InMemoryStorageAdapter(),
      keepRecentUserTurns: 1,
      keepRecentMessagesMin: 2,
      minimumMessagesToCompact: 2,
    });

    await mem.addMessages(session, [
      { role: "system", content: "System guardrail A" } as any,
      { role: "developer", content: "Developer instruction B" } as any,
      {
        role: "user",
        content:
          "A long user instruction that should contribute token pressure.",
      } as any,
      {
        role: "assistant",
        content:
          "A long assistant response that also contributes token pressure.",
      } as any,
      {
        role: "user",
        content: "Another long user turn to force compaction to run now.",
      } as any,
    ]);

    await mem.compactNow(session);
    const prompt = await mem.getPromptMessages(session);
    expect(prompt[0]?.role).toBe("system");
    expect(prompt[1]?.role).toBe("developer");
    expect((prompt[0] as any)?.content).toBe("System guardrail A");
    expect((prompt[1] as any)?.content).toBe("Developer instruction B");

    await mem.dispose();
  });

  test("should persist compaction events and stats", async () => {
    const eventSession = "events-" + Date.now();
    const mem = new MemoryLayer({
      maxTokens: 70,
      threshold: 0.5,
      summarizationModel: mockModel,
      storage: new InMemoryStorageAdapter(),
      keepRecentUserTurns: 1,
      keepRecentMessagesMin: 2,
      minimumMessagesToCompact: 2,
    });

    await mem.addMessages(eventSession, [
      { role: "system", content: "You are strict about output format." } as any,
      {
        role: "user",
        content:
          "First instruction with detailed preferences that should eventually compact.",
      } as any,
      {
        role: "assistant",
        content: "Acknowledged. I will follow these preferences.",
      } as any,
      {
        role: "user",
        content:
          "Second instruction with enough verbosity to cross token thresholds repeatedly.",
      } as any,
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

    await mem.dispose();
  });
});
