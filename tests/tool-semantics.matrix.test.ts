import { describe, test, expect } from "@jest/globals";
import { MemoryLayer } from "../src/memory.js";
import { InMemoryStorageAdapter } from "../src/storage.js";

const mockSummarize = async () => "Mocked summary";

describe("Tool Messages Passthrough", () => {
  const cases: Array<{
    name: string;
    messages: Record<string, any>[];
  }> = [
    {
      name: "preserves orphan tool result",
      messages: [
        { role: "user", content: "Run tool" } as any,
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "orphan-call",
              toolName: "ghostTool",
              result: { ok: false },
            },
          ],
        } as any,
      ],
    },
    {
      name: "preserves mixed valid and invalid tool parts",
      messages: [
        { role: "user", content: "Run tool" } as any,
        {
          role: "tool",
          content: [
            undefined,
            { type: "text", text: "not a provider tool part" },
            {
              type: "tool-result",
              toolCallId: "call-1",
              toolName: "toolA",
              output: { type: "json", value: { ok: true } },
            },
          ],
        } as any,
      ],
    },
  ];

  for (const matrixCase of cases) {
    test(matrixCase.name, async () => {
      const session = `tool-passthrough-${Date.now()}-${matrixCase.name.replace(/\s+/g, "-")}`;
      const memory = new MemoryLayer({
        maxTokens: 1000,
        summarize: mockSummarize,
        storage: new InMemoryStorageAdapter(),
        countTokens: (m) => JSON.stringify(m).length,
      });

      await memory.addMessages(session, null, matrixCase.messages);
      const prompt = await memory.getPromptMessages(session);

      expect(prompt).toEqual(matrixCase.messages);
      const prompt2 = await memory.getPromptMessages(session);
      expect(prompt2).toEqual(prompt);

      await memory.dispose();
    });
  }
});

describe("runId and run-scoped compaction", () => {
  test("messages added with runId are persisted in runId metadata", async () => {
    const session = `run-tag-${Date.now()}`;
    const storage = new InMemoryStorageAdapter();
    const memory = new MemoryLayer({
      maxTokens: 1000,
      summarize: async () => "Summary",
      storage,
      countTokens: (m) => JSON.stringify(m).length,
    });
    const runId = "run-1";
    await memory.addMessages(session, runId, [
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Bye" },
    ]);
    const records = await storage.listMessages(session);
    expect(records.every((r: any) => r.runId === runId)).toBe(true);
    expect(records).toHaveLength(2);
    await memory.dispose();
  });

  test("when compaction runs, current run (runId) is kept as tail and not summarized", async () => {
    const session = `run-scoped-${Date.now()}`;
    const storage = new InMemoryStorageAdapter();
    const memory = new MemoryLayer({
      maxTokens: 80,
      summarize: async () => "Summary of old run",
      storage,
      countTokens: (m) => JSON.stringify(m).length,
      keepRecentUserTurns: 1,
      keepRecentMessagesMin: 2,
      minimumMessagesToCompact: 2,
      threshold: 0.6,
    });
    await memory.addMessages(session, null, [
      { role: "user", content: "Old turn one" },
      { role: "assistant", content: "Old reply one" },
      { role: "user", content: "Old turn two" },
      { role: "assistant", content: "Old reply two" },
    ]);
    const runId = "run-current";
    await memory.addMessages(session, runId, [
      { type: "message", role: "user", content: "New" },
      { type: "function_call", callId: "c1", name: "tool" },
      { type: "function_call_result", callId: "c1", output: "ok" },
    ]);
    const prompt = await memory.getMessages(session);
    const summaryMsg = prompt.find(
      (m: any) =>
        m.role === "system" &&
        typeof m.content === "string" &&
        m.content.includes("Summary"),
    );
    expect(summaryMsg).toBeDefined();
    const records = await storage.listMessages(session);
    const currentRunMessages = records
      .filter((r: any) => r.runId === runId)
      .map((r: any) => r.data);
    expect(currentRunMessages.length).toBe(3);
    expect(currentRunMessages.map((m: any) => m.type ?? m.role)).toEqual([
      "message",
      "function_call",
      "function_call_result",
    ]);
    await memory.dispose();
  });
});
