import { jest, describe, test, expect } from "@jest/globals";
import { summarizeConversation } from "../src/summarizer.js";
import type { ModelMessage } from "ai";

describe("Summarizer", () => {
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
  test("summarizeConversation should call generateText and return summary", async () => {
    const messages = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi!" },
    ];
    const summary = await summarizeConversation(
      messages as ModelMessage[],
      mockModel,
    );

    expect(summary).toBe("Mocked summary");
    expect(mockModel.doGenerate).toHaveBeenCalled();
  });
});
