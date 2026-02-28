import { wrapLanguageModel } from "ai";
import type { LanguageModel, LanguageModelMiddleware } from "ai";
import type {
  LanguageModelV3CallOptions,
  LanguageModelV3Message,
} from "@ai-sdk/provider";
import { MemoryLayer } from "./memory.js";

export interface RecollectCompactionMiddlewareOptions {
  model: LanguageModel;
  memory: MemoryLayer;
  resolveSessionId?: (
    params: LanguageModelV3CallOptions,
  ) => string | undefined | Promise<string | undefined>;
  preCompact?: boolean;
  postCompact?: boolean;
  postCompactStrategy?: "follow-up-only" | "always";
  onMemoryError?: (error: unknown) => void;
}

function defaultResolveSessionId(
  params: LanguageModelV3CallOptions,
): string | undefined {
  const providerOptions = params?.providerOptions;
  return providerOptions?.recollect?.sessionId as string | undefined;
}

function shouldRunPostCompaction(
  result: unknown,
  strategy: "follow-up-only" | "always",
): boolean {
  if (strategy === "always") {
    return true;
  }
  const rawFinishReason = (result as any)?.finishReason;
  const finishReason =
    typeof rawFinishReason === "string"
      ? rawFinishReason
      : typeof rawFinishReason?.unified === "string"
        ? rawFinishReason.unified
        : String(rawFinishReason ?? "");
  return finishReason === "tool-calls" || finishReason === "length";
}

function serializeMessage(message: LanguageModelV3Message): string {
  return JSON.stringify(message);
}

async function appendUnseenMessages(
  memory: MemoryLayer,
  sessionId: string,
  messages: LanguageModelV3Message[],
): Promise<void> {
  if (messages.length === 0) {
    return;
  }

  const existing = await memory.getMessages(sessionId);
  const seen = new Set(existing.map(serializeMessage));
  const unseen: LanguageModelV3Message[] = [];

  for (const message of messages) {
    const key = serializeMessage(message);
    if (seen.has(key)) {
      continue;
    }
    unseen.push(message);
    seen.add(key);
  }

  if (unseen.length > 0) {
    await memory.addMessages(sessionId, unseen);
  }
}

function collectGeneratedMessages(result: unknown): LanguageModelV3Message[] {
  const messages: LanguageModelV3Message[] = [];
  const steps = Array.isArray((result as any)?.steps)
    ? (result as any).steps
    : [];
  for (const step of steps) {
    const stepMessages = Array.isArray(step?.response?.messages)
      ? (step.response.messages as LanguageModelV3Message[])
      : [];
    messages.push(...stepMessages);
  }

  const responseMessages = Array.isArray((result as any)?.response?.messages)
    ? ((result as any).response.messages as LanguageModelV3Message[])
    : [];
  messages.push(...responseMessages);

  const content = Array.isArray((result as any)?.content)
    ? (result as any).content
    : [];
  if (content.length > 0) {
    messages.push({
      role: "assistant",
      content,
    } as LanguageModelV3Message);
  }

  return messages;
}

export function withRecollectCompaction(
  options: RecollectCompactionMiddlewareOptions,
): LanguageModel {
  const {
    model,
    memory,
    resolveSessionId = defaultResolveSessionId,
    preCompact = true,
    postCompact = true,
    postCompactStrategy = "follow-up-only",
    onMemoryError,
  } = options;

  const middleware: LanguageModelMiddleware = {
    specificationVersion: "v3",
    transformParams: async ({ params }) => {
      try {
        const sessionId = await resolveSessionId(params);
        if (sessionId) {
          const prompt = Array.isArray(params.prompt)
            ? (params.prompt as LanguageModelV3Message[])
            : [];

          await appendUnseenMessages(memory, sessionId, prompt);

          if (preCompact) {
            await memory.compactIfNeeded(sessionId, {
              mode: "auto-pre",
              reason: "pre_sampling_compaction",
            });
          }

          const hydrated = await memory.getPromptMessages(sessionId);
          return {
            ...params,
            prompt: hydrated as any,
          };
        }
      } catch (error) {
        onMemoryError?.(error);
      }

      return params;
    },
    wrapGenerate: async ({ doGenerate, params }) => {
      const result = await doGenerate();
      try {
        const sessionId = await resolveSessionId(params);
        if (sessionId) {
          const generatedMessages = collectGeneratedMessages(result);
          await appendUnseenMessages(memory, sessionId, generatedMessages);

          if (
            postCompact &&
            shouldRunPostCompaction(result, postCompactStrategy)
          ) {
            await memory.compactIfNeeded(sessionId, {
              mode: "auto-post",
              reason: "post_sampling_compaction",
            });
          }
        }
      } catch (error) {
        onMemoryError?.(error);
      }

      return result;
    },
  };

  return wrapLanguageModel({
    model: model as any,
    middleware,
  }) as LanguageModel;
}
