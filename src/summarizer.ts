import { generateText } from "ai";
import type { LanguageModel } from "ai";

/**
 * Summarizes a conversation history using a provided language model.
 */
export async function summarizeConversation(
  messages: { role: string; content: string }[],
  model: LanguageModel,
): Promise<string> {
  const conversationText = messages
    .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
    .join("\n\n");

  const { text } = await generateText({
    model,
    system:
      "You are a helpful assistant that summarizes chat histories. Create a concise but comprehensive summary of the conversation so far, preserving all crucial details, user preferences, and context. The summary should be written in the third person.",
    prompt: `Summarize the following chat history:\n\n${conversationText}`,
  });

  return text;
}
