import { jest, describe, test, expect } from "@jest/globals";
import { generateText } from "ai";
import { MemoryLayer } from "../src/memory.js";
import { InMemoryStorageAdapter } from "../src/storage.js";
import { withRecollectCompaction } from "../src/ai-sdk.js";

describe("withRecollectCompaction", () => {
  test("hydrates prompt from memory after auto-ingesting transport messages", async () => {
    const sessionId = "compaction-hydrate-" + Date.now();
    const baseModel: any = {
      specificationVersion: "v3",
      modelId: "mock-model",
      provider: "mock-provider",
      doGenerate: jest.fn<any>().mockResolvedValue({
        content: [{ type: "text", text: "ok" }],
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        warnings: [],
        request: {},
        response: {
          id: "resp-hydrate",
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
    await memory.addMessage(sessionId, "user", "Persisted user turn");

    const model = withRecollectCompaction({
      model: baseModel,
      memory,
      preCompact: true,
      postCompact: false,
    });

    await generateText({
      model: model as any,
      messages: [{ role: "user", content: "Incoming request message" }],
      providerOptions: { recollect: { sessionId } },
    });

    const lastCall = baseModel.doGenerate.mock.calls.at(-1)?.[0];
    const prompt = lastCall?.prompt as any[];
    expect(Array.isArray(prompt)).toBe(true);
    expect(
      prompt.some(
        (message: any) =>
          message.role === "user" &&
          Array.isArray(message.content) &&
          message.content.some(
            (part: any) =>
              part.type === "text" && part.text === "Persisted user turn",
          ),
      ),
    ).toBe(true);
    expect(
      prompt.some(
        (message: any) =>
          message.role === "user" &&
          Array.isArray(message.content) &&
          message.content.some(
            (part: any) =>
              part.type === "text" && part.text === "Incoming request message",
          ),
      ),
    ).toBe(true);

    await memory.dispose();
  });

  test("runs auto-pre compaction before model call", async () => {
    const sessionId = "compaction-pre-" + Date.now();
    const baseModel: any = {
      specificationVersion: "v3",
      modelId: "mock-model",
      provider: "mock-provider",
      doGenerate: jest.fn<any>().mockResolvedValue({
        content: [{ type: "text", text: "ok" }],
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
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
    await memory.addMessage(sessionId, "user", "Hello");

    const model = withRecollectCompaction({
      model: baseModel,
      memory,
      preCompact: true,
      postCompact: false,
    });

    await generateText({
      model: model as any,
      messages: [{ role: "user", content: "Hello" }],
      providerOptions: { recollect: { sessionId } },
    });

    const events = await memory.getSessionEvents(sessionId, 20);
    expect(
      events.some(
        (event) =>
          event.type === "compaction_skipped" &&
          event.payload.mode === "auto-pre",
      ),
    ).toBe(true);

    await memory.dispose();
  });

  test("runs auto-post compaction only for follow-up finish reasons by default", async () => {
    const sessionId = "compaction-post-" + Date.now();
    const baseModel: any = {
      specificationVersion: "v3",
      modelId: "mock-model",
      provider: "mock-provider",
      doGenerate: jest.fn<any>().mockResolvedValue({
        content: [{ type: "text", text: "ok" }],
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        warnings: [],
        request: {},
        response: {
          id: "resp-2",
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

    const model = withRecollectCompaction({
      model: baseModel,
      memory,
      preCompact: false,
      postCompact: true,
    });

    await generateText({
      model: model as any,
      messages: [{ role: "user", content: "Hello" }],
      providerOptions: { recollect: { sessionId } },
    });

    const events = await memory.getSessionEvents(sessionId, 20);
    expect(
      events.some(
        (event) =>
          event.type === "compaction_skipped" &&
          event.payload.mode === "auto-post",
      ),
    ).toBe(false);

    await memory.dispose();
  });

  test("runs auto-post compaction for tool-calls finish reason", async () => {
    const sessionId = "compaction-post-followup-" + Date.now();
    const baseModel: any = {
      specificationVersion: "v3",
      modelId: "mock-model",
      provider: "mock-provider",
      doGenerate: jest.fn<any>().mockResolvedValue({
        content: [{ type: "text", text: "needs tool follow-up" }],
        finishReason: "tool-calls",
        usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
        warnings: [],
        request: {},
        response: {
          id: "resp-tool-calls",
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
    await memory.addMessage(sessionId, "user", "Hello");

    const model = withRecollectCompaction({
      model: baseModel,
      memory,
      preCompact: false,
      postCompact: true,
    });

    await generateText({
      model: model as any,
      messages: [{ role: "user", content: "Hello" }],
      providerOptions: { recollect: { sessionId } },
    });

    const events = await memory.getSessionEvents(sessionId, 20);
    expect(
      events.some(
        (event) =>
          event.type === "compaction_skipped" &&
          event.payload.mode === "auto-post",
      ),
    ).toBe(true);

    await memory.dispose();
  });

  test("persists request and response messages automatically", async () => {
    const sessionId = "compaction-auto-persist-" + Date.now();
    const baseModel: any = {
      specificationVersion: "v3",
      modelId: "mock-model",
      provider: "mock-provider",
      doGenerate: jest.fn<any>().mockResolvedValue({
        content: [{ type: "text", text: "assistant output" }],
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        warnings: [],
        request: {},
        response: {
          id: "resp-no-persist",
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
    const model = withRecollectCompaction({
      model: baseModel,
      memory,
      preCompact: true,
      postCompact: true,
    });

    await generateText({
      model: model as any,
      messages: [{ role: "user", content: "Should be auto-persisted" }],
      providerOptions: { recollect: { sessionId } },
    });

    const history = await memory.getMessages(sessionId);
    const userTexts = history
      .filter((message: any) => message.role === "user")
      .flatMap((message: any) =>
        Array.isArray(message.content) ? message.content : [],
      )
      .filter((part: any) => part?.type === "text")
      .map((part: any) => part.text);
    expect(userTexts).toEqual(["Should be auto-persisted"]);
    expect(history.some((message: any) => message.role === "assistant")).toBe(
      true,
    );

    await memory.dispose();
  });

  test("ingests full assistant/tool/result chain from generated response messages", async () => {
    const sessionId = "compaction-manual-chain-" + Date.now();
    const responseChain = [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "demoTool",
            input: { q: "x" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "demoTool",
            output: { type: "json", value: { ok: true } },
          },
        ],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Tool says ok." }],
      },
    ] as any[];

    const baseModel: any = {
      specificationVersion: "v3",
      modelId: "mock-model",
      provider: "mock-provider",
      doGenerate: jest.fn<any>().mockResolvedValue({
        content: [{ type: "text", text: "final answer" }],
        finishReason: "stop",
        usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 },
        warnings: [],
        request: {},
        response: {
          id: "resp-chain",
          timestamp: new Date(),
          modelId: "mock-model",
          messages: responseChain,
        },
      }),
      doStream: jest.fn<any>(),
    };

    const memory = new MemoryLayer({
      maxTokens: 500,
      summarizationModel: baseModel,
      storage: new InMemoryStorageAdapter(),
    });
    await memory.addMessage(sessionId, "user", "Run tool");

    const model = withRecollectCompaction({
      model: baseModel,
      memory,
      preCompact: true,
      postCompact: true,
    });

    await generateText({
      model: model as any,
      messages: [{ role: "user", content: "Run tool (transport only)" }],
      providerOptions: { recollect: { sessionId } },
    });

    const history = await memory.getMessages(sessionId);
    expect(history.some((message: any) => message.role === "assistant")).toBe(
      true,
    );
    expect(
      history.some(
        (message: any) =>
          (message.role === "tool" || message.role === "assistant") &&
          Array.isArray(message.content) &&
          message.content.some((part: any) => part.type === "tool-result"),
      ),
    ).toBe(true);

    await memory.dispose();
  });
});
