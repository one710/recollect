import { describe, test, expect } from "@jest/globals";
import { countTokens, countMessagesTokens } from "../src/tokenizer.js";
import type { RecollectMessage } from "../src/types.js";

describe("Tokenizer", () => {
  test("countTokens should count tokens in a string", () => {
    const text = "Hello, world!";
    const count = countTokens(text);
    expect(count).toBeGreaterThan(0);
    expect(count).toBe(4); // "Hello", ",", " world", "!" (o200k_base)
  });

  test("countMessagesTokens should count tokens in a list of messages", () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "Hello" }] },
      { role: "assistant", content: [{ type: "text", text: "Hi there!" }] },
    ];
    const count = countMessagesTokens(messages as RecollectMessage[]);
    // Hello (1) + Hi there! (3) + 2 * overhead (4) = 12
    expect(count).toBe(12);
  });

  test("countMessagesTokens should use custom counter if provided", () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "Hello" }] },
    ];
    const customCounter = (text: string) => text.length;
    const count = countMessagesTokens(
      messages as RecollectMessage[],
      customCounter,
    );
    // "Hello" (5) + overhead (4) = 9
    expect(count).toBe(9);
  });
});
