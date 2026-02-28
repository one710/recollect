import { describe, test, expect } from "@jest/globals";
import { MemoryLayer } from "../src/memory.js";
import { InMemoryStorageAdapter } from "../src/storage.js";
import type { LanguageModelV3Message } from "@ai-sdk/provider";

const mockModel: any = {
  specificationVersion: "v3",
  modelId: "mock-model",
  provider: "mock-provider",
  doGenerate: async () => ({
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

describe("Tool Messages Passthrough", () => {
  const cases: Array<{
    name: string;
    messages: LanguageModelV3Message[];
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
        summarizationModel: mockModel,
        storage: new InMemoryStorageAdapter(),
      });

      await memory.addMessages(session, matrixCase.messages);
      const prompt = await memory.getPromptMessages(session);

      expect(prompt).toEqual(matrixCase.messages);
      const prompt2 = await memory.getPromptMessages(session);
      expect(prompt2).toEqual(prompt);

      await memory.dispose();
    });
  }
});
