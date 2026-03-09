export const SUMMARY_MESSAGE_PREFIX = "Conversation checkpoint summary";

export const SUMMARY_INSTRUCTIONS = `
You produce checkpoint summaries for long-running AI conversations.
Preserve user intent, constraints, decisions, unresolved tasks, important tool outputs, and known failures.
Use concise bullet points grouped by: Goals, Decisions, Constraints, Pending Work, and Risks.
Never invent details, only summarize the conversation.
`;

export type MessageRenderer = (message: Record<string, any>) => string;

export interface SummarizeConversationOptions {
  existingSummary?: string | null;
  reason?: string;
  maxInputCharacters?: number;
  renderMessage?: MessageRenderer;
}

export interface SummaryRequest {
  instructions: string;
  summaryPrompt: string;
  messages: Record<string, any>[];
}

export type SummarizeCallable = (
  request: SummaryRequest,
) => Promise<string> | string;

/**
 * Summarizes a conversation history using a provided language model.
 */
export async function summarizeConversation(
  messages: Record<string, any>[],
  summarize: SummarizeCallable,
  options: SummarizeConversationOptions = {},
): Promise<string> {
  const maxInputCharacters = Math.max(
    2000,
    options.maxInputCharacters ?? 120_000,
  );
  const renderer =
    options.renderMessage ?? ((m: Record<string, any>) => JSON.stringify(m));
  const rendered = messages.map(renderer).join("\n\n");
  const conversationText = rendered.slice(-maxInputCharacters);
  const reason = options.reason
    ? `Reason for compaction: ${options.reason}`
    : "Reason for compaction: token budget exceeded.";
  const priorSummary = options.existingSummary?.trim()
    ? `Existing prior summary:\n${options.existingSummary.trim()}\n\n`
    : "";

  const summaryPrompt = `${reason}

${priorSummary}

New transcript segment to merge:

${conversationText}`;
  const text = await summarize({
    instructions: SUMMARY_INSTRUCTIONS,
    summaryPrompt,
    messages,
  });

  return String(text).trim();
}
