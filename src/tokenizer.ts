/**
 * Utility for counting tokens in a list of messages.
 * This is a thin wrapper that sums up the results of a user-provided counter.
 */
export function countMessagesTokens(
  messages: Record<string, any>[],
  counter: (message: Record<string, any>) => number,
): number {
  return messages.reduce((acc, m) => acc + counter(m), 0);
}
