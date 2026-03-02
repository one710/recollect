import { jest, describe, test, expect } from "@jest/globals";
import { summarizeConversation } from "../src/summarizer.js";
import type { RecollectMessage } from "../src/types.js";

describe("Summarizer", () => {
  const summarize = jest.fn(async () => "Mocked summary");
  test("summarizeConversation should call generateText and return summary", async () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "Hello" }] },
      { role: "assistant", content: [{ type: "text", text: "Hi!" }] },
    ];
    const summary = await summarizeConversation(
      messages as RecollectMessage[],
      summarize,
    );

    expect(summary).toBe("Mocked summary");
    expect(summarize).toHaveBeenCalled();
  });
});
