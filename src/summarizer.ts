import { generateText } from "ai";
import type { LanguageModel, ModelMessage } from "ai";

/**
 * Summarizes a conversation history using a provided language model.
 */
export async function summarizeConversation(
  messages: ModelMessage[],
  model: LanguageModel,
): Promise<string> {
  const conversationText = messages
    .map((m) => {
      let content = "";

      if (typeof m.content === "string") {
        content = m.content;
      } else if (Array.isArray(m.content)) {
        content = m.content
          .map((part) => {
            if (part.type === "text") return part.text;
            if (part.type === "image") return "[Image]";
            if (part.type === "file")
              return `[File: ${part.filename || "unnamed"}]`;
            if (part.type === "tool-result") {
              const resultValue = (part as any).result ?? (part as any).output;
              return `[Tool Result for ${part.toolName}: ${JSON.stringify(resultValue)}]`;
            }
            return "";
          })
          .join(" ");
      }

      let toolCalls = "";
      if (m.role === "assistant" && (m as any).toolCalls) {
        toolCalls = (m as any).toolCalls
          .map(
            (tc: any) =>
              `[Tool Call: ${tc.toolName}(${JSON.stringify(tc.args)})]`,
          )
          .join(" ");
      }

      return `${m.role.toUpperCase()}: ${content}${toolCalls ? " " + toolCalls : ""}`;
    })
    .join("\n\n");

  const { text } = await generateText({
    model,
    system:
      "You are a helpful assistant that summarizes chat histories. Create a concise but comprehensive summary of the conversation so far, preserving all crucial details, user preferences, and context. The summary should be written in the third person. Include information about tool interactions if relevant to the summary.",
    prompt: `Summarize the following chat history:\n\n${conversationText}`,
  });

  return text;
}
