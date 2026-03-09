import { describe, test, expect } from "@jest/globals";
import { countMessagesTokens } from "../src/tokenizer.js";

describe("Tokenizer", () => {
  test("countMessagesTokens should count tokens in a list of messages", () => {
    const messages = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there!" },
    ];
    // Simple mock counter: length of content
    const counter = (m: any) => String(m.content).length;
    const count = countMessagesTokens(messages, counter);
    expect(count).toBe(5 + 9);
  });

  test("countMessagesTokens should handle empty list", () => {
    const messages: any[] = [];
    const counter = (m: any) => 1;
    const count = countMessagesTokens(messages, counter);
    expect(count).toBe(0);
  });
});
