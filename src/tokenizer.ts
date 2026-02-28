import { Tokenizer } from "ai-tokenizer";
import * as o200k_base from "ai-tokenizer/encoding/o200k_base";
import type { LanguageModelV3Message } from "@ai-sdk/provider";

const defaultTokenizer = new Tokenizer(o200k_base);

/**
 * Counts the tokens in a given text using the o200k_base encoding.
 */
export function countTokens(text: string): number {
  return defaultTokenizer.count(text);
}

/**
 * Counts the tokens in a list of messages.
 */
export function countMessagesTokens(
  messages: LanguageModelV3Message[],
  counter: (text: string) => number = countTokens,
): number {
  return messages.reduce((acc, m) => {
    let messageTokens = 0;

    // Handle role overhead
    messageTokens += 4;

    // Handle content
    if (typeof m.content === "string") {
      messageTokens += counter(m.content);
    } else if (Array.isArray(m.content)) {
      for (const part of m.content) {
        if (!part || typeof part !== "object") {
          continue;
        }
        if (part.type === "text") {
          messageTokens += counter(part.text);
        } else if (part.type === "file") {
          messageTokens += 85; // Rough estimate for file tokens
        }
      }
    }

    // Handle tool calls in assistant messages
    if (m.role === "assistant" && (m as any).toolCalls) {
      for (const toolCall of (m as any).toolCalls) {
        messageTokens += counter(toolCall.toolName);
        messageTokens += counter(JSON.stringify(toolCall.args));
        messageTokens += 10; // Overhead for tool call structure
      }
    }

    // Handle tool results in tool messages
    if (m.role === "tool" && Array.isArray(m.content)) {
      for (const result of m.content) {
        if (!result || typeof result !== "object") {
          continue;
        }
        if (result.type === "tool-result") {
          const resultValue = (result as any).result ?? (result as any).output;
          messageTokens += counter(JSON.stringify(resultValue) ?? "");
          messageTokens += 10; // Overhead for tool result structure
        }
      }
    }

    return acc + messageTokens;
  }, 0);
}
