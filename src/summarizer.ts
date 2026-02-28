import { generateText } from "ai";
import type { LanguageModel, ModelMessage } from "ai";

export const SUMMARY_MESSAGE_PREFIX = "Conversation checkpoint summary";

export interface SummarizeConversationOptions {
  existingSummary?: string | null;
  reason?: string;
  maxInputCharacters?: number;
}

function renderMessage(message: ModelMessage): string {
  let content = "";

  if (typeof message.content === "string") {
    content = message.content;
  } else if (Array.isArray(message.content)) {
    content = message.content
      .map((part) => {
        if (part.type === "text") return part.text;
        if (part.type === "image") return "[Image]";
        if (part.type === "file")
          return `[File: ${part.filename || "unnamed"}]`;
        if (part.type === "tool-result") {
          const resultValue = (part as any).result ?? (part as any).output;
          return `[Tool Result ${part.toolName}: ${JSON.stringify(resultValue)}]`;
        }
        return "";
      })
      .filter((line) => line.length > 0)
      .join(" ");
  }

  let toolCalls = "";
  if (message.role === "assistant" && (message as any).toolCalls) {
    toolCalls = (message as any).toolCalls
      .map(
        (toolCall: any) =>
          `[Tool Call ${toolCall.toolName}(${JSON.stringify(toolCall.args)})]`,
      )
      .join(" ");
  }

  const role = String(message.role).toUpperCase();
  if (toolCalls.length > 0) {
    return `${role}: ${content} ${toolCalls}`.trim();
  }
  return `${role}: ${content}`.trim();
}

/**
 * Summarizes a conversation history using a provided language model.
 */
export async function summarizeConversation(
  messages: ModelMessage[],
  model: LanguageModel,
  options: SummarizeConversationOptions = {},
): Promise<string> {
  const maxInputCharacters = Math.max(
    2000,
    options.maxInputCharacters ?? 120_000,
  );
  const rendered = messages.map(renderMessage).join("\n\n");
  const conversationText = rendered.slice(-maxInputCharacters);
  const reason = options.reason
    ? `Reason for compaction: ${options.reason}`
    : "Reason for compaction: token budget exceeded.";
  const priorSummary = options.existingSummary?.trim()
    ? `Existing prior summary:\n${options.existingSummary.trim()}\n\n`
    : "";

  const { text } = await generateText({
    model,
    system:
      "You produce checkpoint summaries for long-running AI conversations. Preserve user intent, constraints, decisions, unresolved tasks, important tool outputs, and known failures. Use concise bullet points grouped by: Goals, Decisions, Constraints, Pending Work, and Risks. Never invent details.",
    prompt: `${reason}

${priorSummary}New transcript segment to merge:
${conversationText}`,
  });

  return text.trim();
}
