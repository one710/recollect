import { wrapLanguageModel } from "ai";
import type { LanguageModel, LanguageModelMiddleware } from "ai";
import type {
  LanguageModelV3CallOptions,
  LanguageModelV3Message,
} from "@ai-sdk/provider";
import { MemoryLayer } from "./memory.js";
import {
  collectGeneratedMessages,
  findPromptSuffixToAppend,
  normalizeMessages,
  shouldRunPostCompaction,
  uniqueWithinBatch,
} from "./ai-sdk-utils.js";

export interface RecollectCompactionMiddlewareOptions {
  model: LanguageModel;
  memory: MemoryLayer;
  resolveUserId?: (
    params: LanguageModelV3CallOptions,
  ) => string | undefined | Promise<string | undefined>;
  resolveSessionId?: (
    params: LanguageModelV3CallOptions,
  ) => string | undefined | Promise<string | undefined>;
  preCompact?: boolean;
  postCompact?: boolean;
  postCompactStrategy?: "follow-up-only" | "always";
  skipSystemMessagesInHistory?: boolean;
  onMemoryError?: (error: unknown) => void;
}

function defaultResolveUserId(
  params: LanguageModelV3CallOptions,
): string | undefined {
  const providerOptions = params?.providerOptions;
  return providerOptions?.recollect?.userId as string | undefined;
}

function defaultResolveSessionId(
  params: LanguageModelV3CallOptions,
): string | undefined {
  const providerOptions = params?.providerOptions;
  return providerOptions?.recollect?.sessionId as string | undefined;
}

export function withRecollectCompaction(
  options: RecollectCompactionMiddlewareOptions,
): LanguageModel {
  const {
    model,
    memory,
    resolveUserId = defaultResolveUserId,
    resolveSessionId = defaultResolveSessionId,
    preCompact = true,
    postCompact = true,
    postCompactStrategy = "follow-up-only",
    skipSystemMessagesInHistory = true,
    onMemoryError,
  } = options;
  const promptRunsSeen = new Set<string>();
  const generatedRunsSeen = new Set<string>();
  const maxRunKeys = 5000;

  function markSeen(set: Set<string>, key: string): void {
    if (set.has(key)) {
      return;
    }
    set.add(key);
    if (set.size <= maxRunKeys) {
      return;
    }
    const oldest = set.values().next().value as string | undefined;
    if (oldest) {
      set.delete(oldest);
    }
  }

  async function getRunKey(
    params: LanguageModelV3CallOptions,
    userId: string,
  ): Promise<string | null> {
    const sessionId = await resolveSessionId(params);
    return sessionId ? `${userId}::${sessionId}` : null;
  }

  function shouldProcessRun(seen: Set<string>, runKey: string | null): boolean {
    return !runKey || !seen.has(runKey);
  }

  function markProcessedRun(seen: Set<string>, runKey: string | null): void {
    if (runKey) {
      markSeen(seen, runKey);
    }
  }

  async function ingestPromptAndHydrate(
    params: LanguageModelV3CallOptions,
  ): Promise<LanguageModelV3CallOptions> {
    const userId = await resolveUserId(params);
    if (!userId) {
      return params;
    }

    const runKey = await getRunKey(params, userId);
    const prompt = Array.isArray(params.prompt)
      ? (params.prompt as LanguageModelV3Message[])
      : [];
    const promptHistory = skipSystemMessagesInHistory
      ? prompt.filter(
          (message, index) => index === 0 || message.role !== "system",
        )
      : prompt;

    if (shouldProcessRun(promptRunsSeen, runKey)) {
      const existing = await memory.getMessages(userId);
      const promptSuffix = findPromptSuffixToAppend(existing, promptHistory);
      if (promptSuffix.length > 0) {
        await memory.addMessages(userId, promptSuffix);
      }

      if (preCompact) {
        await memory.compactIfNeeded(userId, {
          mode: "auto-pre",
          reason: "pre_sampling_compaction",
        });
      }
      markProcessedRun(promptRunsSeen, runKey);
    }

    const hydratedRaw = await memory.getPromptMessages(userId);
    const hydrated = normalizeMessages(hydratedRaw);
    return {
      ...params,
      prompt: hydrated as any,
    };
  }

  async function ingestGeneratedAndMaybeCompact(
    params: LanguageModelV3CallOptions,
    result: unknown,
  ): Promise<void> {
    const userId = await resolveUserId(params);
    if (!userId) {
      return;
    }

    const runKey = await getRunKey(params, userId);
    if (!shouldProcessRun(generatedRunsSeen, runKey)) {
      return;
    }

    const generatedMessages = collectGeneratedMessages(result);
    const generatedUnique = uniqueWithinBatch(generatedMessages);
    if (generatedUnique.length > 0) {
      await memory.addMessages(userId, generatedUnique);
    }

    if (postCompact && shouldRunPostCompaction(result, postCompactStrategy)) {
      await memory.compactIfNeeded(userId, {
        mode: "auto-post",
        reason: "post_sampling_compaction",
      });
    }
    markProcessedRun(generatedRunsSeen, runKey);
  }

  const middleware: LanguageModelMiddleware = {
    specificationVersion: "v3",
    transformParams: async ({ params }) => {
      try {
        return await ingestPromptAndHydrate(params);
      } catch (error) {
        onMemoryError?.(error);
      }

      return params;
    },
    wrapGenerate: async ({ doGenerate, params }) => {
      const result = await doGenerate();
      try {
        await ingestGeneratedAndMaybeCompact(params, result);
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
