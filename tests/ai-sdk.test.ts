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
import type { ModelMessage } from "ai";

describe("AI SDK Support", () => {
  const mockModel: any = {
    specificationVersion: "v3",
    modelId: "mock-model",
    provider: "mock-provider",
    doGenerate: jest.fn<any>().mockResolvedValue({
      text: "Mocked tool-aware summary",
      content: [{ type: "text", text: "Mocked tool-aware summary" }],
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
  const sessionId = "ai-sdk-session-" + Date.now();

  beforeAll(async () => {
    memory = new MemoryLayer({
      maxTokens: 600,
      summarizationModel: mockModel,
      threshold: 0.5,
      storage: new InMemoryStorageAdapter(),
      keepRecentUserTurns: 2,
      keepRecentMessagesMin: 3,
      minimumMessagesToCompact: 2,
    });
  });

  afterAll(async () => {
    await memory.clearSession(sessionId);
    await memory.dispose();
  });

  test("should handle multi-part user messages", async () => {
    const message: ModelMessage = {
      role: "user",
      content: [
        { type: "text", text: "What is in this image?" },
        { type: "image", image: "https://example.com/image.png" },
      ],
    };

    await memory.addMessage(sessionId, null, message);
    const history = await memory.getMessages(sessionId);
    expect(history.length).toBe(1);
    expect(history[0]).toEqual(message);
  });

  test("should handle tool calls and results", async () => {
    const assistantMessage: ModelMessage = {
      role: "assistant",
      content: "Let me check the weather.",
      toolCalls: [
        {
          type: "tool-call",
          toolCallId: "call-1",
          toolName: "getWeather",
          args: { city: "London" },
        },
      ],
    } as any;

    const toolMessage: ModelMessage = {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "call-1",
          toolName: "getWeather",
          result: { temperature: 20 },
        },
      ],
    } as any;

    await memory.addMessage(sessionId, null, assistantMessage);
    await memory.addMessage(sessionId, null, toolMessage);

    const history = await memory.getMessages(sessionId);
    // Since we added 3 messages total (including the previous test) and threshold is 0.1 of 500 (50 tokens),
    // and we added complex messages, summarization might have triggered.
    // Let's check if we have either the full history or a summary.

    if (history.length === 1 && history[0].role === "system") {
      expect(history[0].content).toContain("Summary");
      expect(history[0].content).toContain("tool-aware");
    } else {
      expect(history).toContainEqual(assistantMessage);
      expect(history).toContainEqual(toolMessage);
    }
  });

  test("should trigger compaction with complex messages", async () => {
    const largeMessage: ModelMessage = {
      role: "user",
      content: "Repeat this ".repeat(500),
    };

    await memory.addMessage(sessionId, null, largeMessage);
    await memory.compactNow(sessionId);

    const history = await memory.getMessages(sessionId);
    expect(history.length).toBeGreaterThanOrEqual(1);
    const summary = history.find(
      (message) =>
        message.role === "system" &&
        typeof message.content === "string" &&
        message.content.includes("Conversation checkpoint summary"),
    );
    expect(summary).toBeDefined();
    expect((summary as ModelMessage).content).toContain(
      "Mocked tool-aware summary",
    );
  });
});
