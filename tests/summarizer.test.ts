import { jest, describe, test, expect } from "@jest/globals";
import { summarizeConversation } from "../src/summarizer.js";

describe("Summarizer", () => {
  const mockModel: any = {
    specificationVersion: "v2",
    modelId: "mock-model",
    provider: "mock-provider",
    doGenerate: jest.fn<any>().mockResolvedValue({
      text: "Mocked summary",
      finishReason: "stop",
      usage: { promptTokens: 10, completionTokens: 5 },
      rawCall: { rawPrompt: "...", rawSettings: {} },
      content: [{ type: "text", text: "Mocked summary" }],
      warnings: [],
    }),
  };

  test("summarizeConversation should call generateText and return summary", async () => {
    const messages = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi!" },
    ];
    const summary = await summarizeConversation(messages, mockModel);

    expect(summary).toBe("Mocked summary");
    expect(mockModel.doGenerate).toHaveBeenCalled();
  });
});
