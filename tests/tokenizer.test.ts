import { describe, test, expect } from "@jest/globals";
import { countTokens, countMessagesTokens } from "../src/tokenizer.js";
import type { ModelMessage } from "ai";

describe("Tokenizer", () => {
  test("countTokens should count tokens in a string", () => {
    const text = "Hello, world!";
    const count = countTokens(text);
    expect(count).toBeGreaterThan(0);
    expect(count).toBe(4); // "Hello", ",", " world", "!" (o200k_base)
  });

  test("countMessagesTokens should count tokens in a list of messages", () => {
    const messages = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there!" },
    ];
    const count = countMessagesTokens(messages as ModelMessage[]);
    // Hello (1) + Hi there! (3) + 2 * overhead (4) = 12
    expect(count).toBe(12);
  });

  test("countMessagesTokens should use custom counter if provided", () => {
    const messages = [{ role: "user", content: "Hello" }];
    const customCounter = (text: string) => text.length;
    const count = countMessagesTokens(
      messages as ModelMessage[],
      customCounter,
    );
    // "Hello" (5) + overhead (4) = 9
    expect(count).toBe(9);
  });
});
