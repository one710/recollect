import { Tokenizer } from "ai-tokenizer";
import * as o200k_base from "ai-tokenizer/encoding/o200k_base";

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
  messages: { role: string; content: string }[],
): number {
  return messages.reduce((acc, m) => acc + countTokens(m.content) + 4, 0); // Adding minor overhead for role/formatting
}
