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

  test("preserves intentional repeated user messages across turns", async () => {
    const sessionId = "compaction-repeat-user-" + Date.now();
    const baseModel: any = {
      specificationVersion: "v3",
      modelId: "mock-model",
      provider: "mock-provider",
      doGenerate: jest
        .fn<any>()
        .mockResolvedValueOnce({
          content: [{ type: "text", text: "reply one" }],
          finishReason: "stop",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          warnings: [],
          request: {},
          response: {
            id: "resp-r1",
            timestamp: new Date(),
            modelId: "mock-model",
          },
        })
        .mockResolvedValueOnce({
          content: [{ type: "text", text: "reply two" }],
          finishReason: "stop",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          warnings: [],
          request: {},
          response: {
            id: "resp-r2",
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
      messages: [{ role: "user", content: "Hi" }],
      providerOptions: { recollect: { sessionId } },
    });

    const historyAfterFirstTurn = await memory.getMessages(sessionId);
    await generateText({
      model: model as any,
      messages: [
        ...(historyAfterFirstTurn as any),
        { role: "user", content: "Hi" },
      ],
      providerOptions: { recollect: { sessionId } },
    });

    const history = await memory.getMessages(sessionId);
    const userHiCount = history.filter((message: any) => {
      if (message.role !== "user" || !Array.isArray(message.content)) {
        return false;
      }
      return message.content.some(
        (part: any) => part?.type === "text" && part.text === "Hi",
      );
    }).length;
    expect(userHiCount).toBe(2);

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

  test("normalizes tool-call input strings and dedupes object/string equivalents", async () => {
    const sessionId = "compaction-toolcall-normalize-" + Date.now();
    const toolCallId = "call-normalize-1";
    const toolName = "demoTool";
    const toolInputObject = { thought: "plan", thoughtNumber: 1 };
    const toolInputString = JSON.stringify(toolInputObject);
    const baseModel: any = {
      specificationVersion: "v3",
      modelId: "mock-model",
      provider: "mock-provider",
      doGenerate: jest
        .fn<any>()
        .mockResolvedValueOnce({
          content: [
            {
              type: "tool-call",
              toolCallId,
              toolName,
              input: toolInputString,
            },
          ],
          finishReason: "tool-calls",
          usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 },
          warnings: [],
          request: {},
          response: {
            id: "resp-toolcall-1",
            timestamp: new Date(),
            modelId: "mock-model",
          },
        })
        .mockResolvedValueOnce({
          content: [{ type: "text", text: "done" }],
          finishReason: "stop",
          usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 },
          warnings: [],
          request: {},
          response: {
            id: "resp-toolcall-2",
            timestamp: new Date(),
            modelId: "mock-model",
          },
        }),
      doStream: jest.fn<any>(),
    };

    const memory = new MemoryLayer({
      maxTokens: 1000,
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
      messages: [{ role: "user", content: "run tool" }],
      providerOptions: { recollect: { sessionId } },
    });

    await generateText({
      model: model as any,
      messages: [
        { role: "user", content: "run tool" },
        {
          role: "assistant",
          content: [
            { type: "tool-call", toolCallId, toolName, input: toolInputObject },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId,
              toolName,
              output: { type: "json", value: { ok: true } },
            },
          ],
        },
        { role: "user", content: "continue" },
      ],
      providerOptions: { recollect: { sessionId } },
    });

    const secondCall = baseModel.doGenerate.mock.calls[1]?.[0];
    const secondPrompt = (secondCall?.prompt ?? []) as any[];
    const assistantToolMessages = secondPrompt.filter(
      (message: any) =>
        message.role === "assistant" &&
        Array.isArray(message.content) &&
        message.content.some(
          (part: any) =>
            part.type === "tool-call" && part.toolCallId === toolCallId,
        ),
    );
    expect(assistantToolMessages).toHaveLength(1);

    const toolCallPart = assistantToolMessages[0]?.content?.find(
      (part: any) =>
        part.type === "tool-call" && part.toolCallId === toolCallId,
    );
    expect(typeof toolCallPart?.input).toBe("object");
    expect(toolCallPart?.input).toEqual(toolInputObject);

    await memory.dispose();
  });

  test("uses sessionRunId to avoid duplicate ingestion on retries", async () => {
    const sessionId = "compaction-run-idempotent-" + Date.now();
    const sessionRunId = "run-123";
    const baseModel: any = {
      specificationVersion: "v3",
      modelId: "mock-model",
      provider: "mock-provider",
      doGenerate: jest
        .fn<any>()
        .mockResolvedValueOnce({
          content: [{ type: "text", text: "first reply" }],
          finishReason: "stop",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          warnings: [],
          request: {},
          response: {
            id: "resp-idem-1",
            timestamp: new Date(),
            modelId: "mock-model",
          },
        })
        .mockResolvedValueOnce({
          content: [{ type: "text", text: "first reply" }],
          finishReason: "stop",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          warnings: [],
          request: {},
          response: {
            id: "resp-idem-2",
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

    const params = {
      model: model as any,
      messages: [{ role: "user", content: "Hello once" }],
      providerOptions: { recollect: { sessionId, sessionRunId } },
    } as any;

    await generateText(params);
    await generateText(params);

    const history = await memory.getMessages(sessionId);
    const userCount = history.filter(
      (message: any) => message.role === "user",
    ).length;
    const assistantCount = history.filter(
      (message: any) =>
        message.role === "assistant" &&
        Array.isArray(message.content) &&
        message.content.some(
          (part: any) => part.type === "text" && part.text === "first reply",
        ),
    ).length;

    expect(userCount).toBe(1);
    expect(assistantCount).toBe(1);

    await memory.dispose();
  });

  test("does not persist reasoning parts in memory history", async () => {
    const sessionId = "compaction-no-reasoning-" + Date.now();
    const baseModel: any = {
      specificationVersion: "v3",
      modelId: "mock-model",
      provider: "mock-provider",
      doGenerate: jest.fn<any>().mockResolvedValue({
        content: [
          { type: "reasoning", text: "private chain of thought" },
          { type: "text", text: "Final answer only." },
        ],
        finishReason: "stop",
        usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
        warnings: [],
        request: {},
        response: {
          id: "resp-reasoning",
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
      messages: [{ role: "user", content: "Answer briefly" }],
      providerOptions: {
        recollect: { sessionId, sessionRunId: "run-reasoning" },
      },
    });

    const history = await memory.getMessages(sessionId);
    const assistant = history.find(
      (message: any) => message.role === "assistant",
    ) as any;
    expect(assistant).toBeTruthy();
    expect(Array.isArray(assistant.content)).toBe(true);
    expect(
      assistant.content.some((part: any) => part?.type === "reasoning"),
    ).toBe(false);
    expect(
      assistant.content.some(
        (part: any) =>
          part?.type === "text" && part.text === "Final answer only.",
      ),
    ).toBe(true);

    await memory.dispose();
  });

  test("does not duplicate when prompt resend uses string-vs-parts variants", async () => {
    const sessionId = "compaction-shape-canonicalization-" + Date.now();
    const turn1 = "Give one sentence on long-chat memory.";
    const turn2 = "Expand that into three bullets.";
    const baseModel: any = {
      specificationVersion: "v3",
      modelId: "mock-model",
      provider: "mock-provider",
      doGenerate: jest
        .fn<any>()
        .mockResolvedValueOnce({
          content: [{ type: "text", text: "First answer" }],
          finishReason: "stop",
          usage: { inputTokens: 2, outputTokens: 2, totalTokens: 4 },
          warnings: [],
          request: {},
          response: {
            id: "resp-shape-1",
            timestamp: new Date(),
            modelId: "mock-model",
          },
        })
        .mockResolvedValueOnce({
          content: [{ type: "text", text: "Second answer" }],
          finishReason: "stop",
          usage: { inputTokens: 2, outputTokens: 2, totalTokens: 4 },
          warnings: [],
          request: {},
          response: {
            id: "resp-shape-2",
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

    // First turn arrives as content parts.
    await generateText({
      model: model as any,
      messages: [{ role: "user", content: [{ type: "text", text: turn1 }] }],
      providerOptions: {
        recollect: { sessionId, sessionRunId: "shape-run-1" },
      },
    } as any);

    const persistedAfterTurn1 = await memory.getMessages(sessionId);
    const firstAssistant = persistedAfterTurn1.find(
      (message: any) => message.role === "assistant",
    ) as any;
    const assistantText =
      Array.isArray(firstAssistant?.content) &&
      firstAssistant.content[0]?.type === "text"
        ? firstAssistant.content[0].text
        : "First answer";

    // Resend full history but with string forms.
    await generateText({
      model: model as any,
      messages: [
        { role: "user", content: turn1 },
        { role: "assistant", content: assistantText },
        { role: "user", content: turn2 },
      ],
      providerOptions: {
        recollect: { sessionId, sessionRunId: "shape-run-2" },
      },
    } as any);

    const history = await memory.getMessages(sessionId);
    const turn1Count = history.filter((message: any) => {
      if (message.role !== "user" || !Array.isArray(message.content)) {
        return false;
      }
      return message.content.some(
        (part: any) => part.type === "text" && part.text === turn1,
      );
    }).length;
    const turn2Count = history.filter((message: any) => {
      if (message.role !== "user" || !Array.isArray(message.content)) {
        return false;
      }
      return message.content.some(
        (part: any) => part.type === "text" && part.text === turn2,
      );
    }).length;
    expect(turn1Count).toBe(1);
    expect(turn2Count).toBe(1);

    await memory.dispose();
  });
});
