import { wrapLanguageModel } from "ai";
import type { LanguageModel, LanguageModelMiddleware, ModelMessage } from "ai";
import { MemoryLayer } from "./memory.js";

export interface RecollectMiddlewareOptions {
  model: LanguageModel;
  memory: MemoryLayer;
  /**
   * Resolve session id per model call.
   * By default this reads `providerOptions.recollect.sessionId`.
   */
  resolveSessionId?: (
    params: unknown,
  ) => string | undefined | Promise<string | undefined>;
  /**
   * Sync incoming prompt messages into persisted memory.
   * Defaults to true.
   */
  persistIncomingPrompt?: boolean;
  /**
   * Persist assistant output of generate calls.
   * Defaults to true.
   */
  persistAssistantOnGenerate?: boolean;
  /**
   * Run compaction before each model call.
   * Defaults to true.
   */
  preCompact?: boolean;
  /**
   * Run compaction after generate calls.
   * Defaults to true.
   */
  postCompact?: boolean;
  /**
   * Determines when post-compaction runs.
   * - follow-up-only: only when finishReason implies follow-up work
   * - always: always run post compaction check
   */
  postCompactStrategy?: "follow-up-only" | "always";
  /**
   * Called for memory errors. By default errors are swallowed.
   */
  onMemoryError?: (error: unknown) => void;
}

function defaultResolveSessionId(params: unknown): string | undefined {
  const providerOptions = (params as any)?.providerOptions;
  return providerOptions?.recollect?.sessionId;
}

function toModelMessages(prompt: unknown): ModelMessage[] {
  if (!Array.isArray(prompt)) {
    return [];
  }
  return prompt as ModelMessage[];
}

function buildAssistantMessageFromGenerateResult(
  result: unknown,
): ModelMessage | null {
  const content = (result as any)?.content;
  if (!Array.isArray(content) || content.length === 0) {
    return null;
  }
  return {
    role: "assistant",
    content: content as any,
  };
}

function shouldRunPostCompaction(
  result: unknown,
  strategy: "follow-up-only" | "always",
): boolean {
  if (strategy === "always") {
    return true;
  }
  const finishReason = String((result as any)?.finishReason ?? "");
  return finishReason === "tool-calls" || finishReason === "length";
}

/**
 * Wrap a model so Recollect memory is automatically hydrated and maintained.
 *
 * Expected per-call session id:
 * providerOptions: { recollect: { sessionId: "..." } }
 */
export function withRecollectMemory(
  options: RecollectMiddlewareOptions,
): LanguageModel {
  const {
    model,
    memory,
    resolveSessionId = defaultResolveSessionId,
    persistIncomingPrompt = true,
    persistAssistantOnGenerate = true,
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
        if (!sessionId) {
          return params;
        }

        const incomingPrompt = toModelMessages((params as any).prompt);
        if (persistIncomingPrompt && incomingPrompt.length > 0) {
          await memory.syncFromPrompt(sessionId, incomingPrompt);
        }

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
      } catch (error) {
        onMemoryError?.(error);
        return params;
      }
    },
    wrapGenerate: async ({ doGenerate, params }) => {
      const result = await doGenerate();
      try {
        const sessionId = await resolveSessionId(params);
        if (!sessionId) {
          return result;
        }

        if (persistAssistantOnGenerate) {
          const assistantMessage =
            buildAssistantMessageFromGenerateResult(result);
          if (assistantMessage) {
            await memory.addMessage(sessionId, null, assistantMessage);
          }
        }

        if (
          postCompact &&
          shouldRunPostCompaction(result, postCompactStrategy)
        ) {
          await memory.compactIfNeeded(sessionId, {
            mode: "auto-post",
            reason: "post_sampling_compaction",
          });
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
