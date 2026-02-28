import { jest, describe, test, expect } from "@jest/globals";
import { generateText } from "ai";
import { MemoryLayer } from "../src/memory.js";
import { InMemoryStorageAdapter } from "../src/storage.js";
import { withRecollectMemory } from "../src/ai-sdk.js";

describe("withRecollectMemory", () => {
  test("hydrates prompt and persists generated assistant message", async () => {
    const sessionId = "middleware-session-" + Date.now();
    const baseModel: any = {
      specificationVersion: "v3",
      modelId: "mock-model",
      provider: "mock-provider",
      doGenerate: jest.fn<any>().mockResolvedValue({
        content: [{ type: "text", text: "Generated reply" }],
        finishReason: "stop",
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        warnings: [],
        request: {},
        response: {
          id: "resp-1",
          timestamp: new Date(),
          modelId: "mock-model",
        },
      }),
      doStream: jest.fn<any>(),
    };

    const memory = new MemoryLayer({
      maxTokens: 500,
      summarizationModel: baseModel,
      storage: new InMemoryStorageAdapter(),
    });

    const model = withRecollectMemory({
      model: baseModel,
      memory,
    });

    await generateText({
      model: model as any,
      messages: [{ role: "user", content: "Hello memory middleware" }],
      providerOptions: {
        recollect: {
          sessionId,
        },
      },
    });

    const history = await memory.getMessages(sessionId);
    expect(history.length).toBeGreaterThanOrEqual(2);
    expect(history[0]?.role).toBe("user");
    expect(history.some((msg) => msg.role === "assistant")).toBe(true);
    const events = await memory.getSessionEvents(sessionId, 20);
    expect(events.some((event) => event.type === "prompt_synced")).toBe(true);

    await memory.dispose();
  });

  test("runs pre/post compaction hooks in middleware lifecycle", async () => {
    const sessionId = "middleware-compact-" + Date.now();
    const baseModel: any = {
      specificationVersion: "v3",
      modelId: "mock-model",
      provider: "mock-provider",
      doGenerate: jest.fn<any>().mockResolvedValue({
        content: [{ type: "text", text: "Needs follow-up" }],
        finishReason: "tool-calls",
        usage: { inputTokens: 120, outputTokens: 50, totalTokens: 170 },
        warnings: [],
        request: {},
        response: {
          id: "resp-compact",
          timestamp: new Date(),
          modelId: "mock-model",
        },
      }),
      doStream: jest.fn<any>(),
    };

    const memory = new MemoryLayer({
      maxTokens: 120,
      threshold: 0.5,
      summarizationModel: baseModel,
      storage: new InMemoryStorageAdapter(),
      minimumMessagesToCompact: 2,
      keepRecentUserTurns: 1,
      keepRecentMessagesMin: 2,
    });

    await memory.addMessages(sessionId, [
      { role: "system", content: "Maintain strict formatting." } as any,
      {
        role: "user",
        content:
          "Long historical context with many details that will likely trigger compaction before sampling.",
      } as any,
      {
        role: "assistant",
        content:
          "Stored response with additional context and structured output requirements.",
      } as any,
    ]);

    const model = withRecollectMemory({
      model: baseModel,
      memory,
      preCompact: true,
      postCompact: true,
    });

    await generateText({
      model: model as any,
      messages: [{ role: "user", content: "Proceed with next step." }],
      providerOptions: {
        recollect: {
          sessionId,
        },
      },
    });

    const events = await memory.getSessionEvents(sessionId, 100);
    expect(
      events.some(
        (event) =>
          (event.type === "compaction_started" ||
            event.type === "compaction_skipped") &&
          event.payload.mode === "auto-pre",
      ),
    ).toBe(true);
    expect(
      events.some(
        (event) =>
          (event.type === "compaction_started" ||
            event.type === "compaction_skipped") &&
          event.payload.mode === "auto-post",
      ),
    ).toBe(true);

    await memory.dispose();
  });

  test("post compaction strategy follow-up-only skips for stop finish reason", async () => {
    const sessionId = "middleware-post-strategy-stop-" + Date.now();
    const baseModel: any = {
      specificationVersion: "v3",
      modelId: "mock-model",
      provider: "mock-provider",
      doGenerate: jest.fn<any>().mockResolvedValue({
        content: [{ type: "text", text: "Done." }],
        finishReason: "stop",
        usage: { inputTokens: 40, outputTokens: 10, totalTokens: 50 },
        warnings: [],
        request: {},
        response: {
          id: "resp-stop",
          timestamp: new Date(),
          modelId: "mock-model",
        },
      }),
      doStream: jest.fn<any>(),
    };

    const memory = new MemoryLayer({
      maxTokens: 80,
      threshold: 0.5,
      summarizationModel: baseModel,
      storage: new InMemoryStorageAdapter(),
      minimumMessagesToCompact: 2,
    });

    const model = withRecollectMemory({
      model: baseModel,
      memory,
      preCompact: false,
      postCompact: true,
      postCompactStrategy: "follow-up-only",
    });

    await generateText({
      model: model as any,
      messages: [{ role: "user", content: "Simple question" }],
      providerOptions: {
        recollect: {
          sessionId,
        },
      },
    });

    const events = await memory.getSessionEvents(sessionId, 100);
    expect(
      events.some(
        (event) =>
          (event.type === "compaction_started" ||
            event.type === "compaction_skipped") &&
          event.payload.mode === "auto-post",
      ),
    ).toBe(false);

    await memory.dispose();
  });

  test("post compaction strategy always executes regardless of finish reason", async () => {
    const sessionId = "middleware-post-strategy-always-" + Date.now();
    const baseModel: any = {
      specificationVersion: "v3",
      modelId: "mock-model",
      provider: "mock-provider",
      doGenerate: jest.fn<any>().mockResolvedValue({
        content: [{ type: "text", text: "Done." }],
        finishReason: "stop",
        usage: { inputTokens: 40, outputTokens: 10, totalTokens: 50 },
        warnings: [],
        request: {},
        response: {
          id: "resp-stop-always",
          timestamp: new Date(),
          modelId: "mock-model",
        },
      }),
      doStream: jest.fn<any>(),
    };

    const memory = new MemoryLayer({
      maxTokens: 80,
      threshold: 0.5,
      summarizationModel: baseModel,
      storage: new InMemoryStorageAdapter(),
      minimumMessagesToCompact: 2,
    });

    const model = withRecollectMemory({
      model: baseModel,
      memory,
      preCompact: false,
      postCompact: true,
      postCompactStrategy: "always",
    });

    await generateText({
      model: model as any,
      messages: [{ role: "user", content: "Simple question" }],
      providerOptions: {
        recollect: {
          sessionId,
        },
      },
    });

    const events = await memory.getSessionEvents(sessionId, 100);
    expect(
      events.some(
        (event) =>
          (event.type === "compaction_started" ||
            event.type === "compaction_skipped") &&
          event.payload.mode === "auto-post",
      ),
    ).toBe(true);

    await memory.dispose();
  });
});
