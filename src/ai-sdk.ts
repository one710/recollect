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
  resolveSessionId?: (
    params: LanguageModelV3CallOptions,
  ) => string | undefined | Promise<string | undefined>;
  resolveSessionRunId?: (
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

function defaultResolveSessionRunId(
  params: LanguageModelV3CallOptions,
): string | undefined {
  const providerOptions = params?.providerOptions;
  return providerOptions?.recollect?.sessionRunId as string | undefined;
}

export function withRecollectCompaction(
  options: RecollectCompactionMiddlewareOptions,
): LanguageModel {
  const {
    model,
    memory,
    resolveSessionId = defaultResolveSessionId,
    resolveSessionRunId = defaultResolveSessionRunId,
    preCompact = true,
    postCompact = true,
    postCompactStrategy = "follow-up-only",
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
    sessionId: string,
  ): Promise<string | null> {
    const sessionRunId = await resolveSessionRunId(params);
    return sessionRunId ? `${sessionId}::${sessionRunId}` : null;
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
    const sessionId = await resolveSessionId(params);
    if (!sessionId) {
      return params;
    }

    const runKey = await getRunKey(params, sessionId);
    const prompt = Array.isArray(params.prompt)
      ? (params.prompt as LanguageModelV3Message[])
      : [];

    if (shouldProcessRun(promptRunsSeen, runKey)) {
      const existing = await memory.getMessages(sessionId);
      const promptSuffix = findPromptSuffixToAppend(existing, prompt);
      if (promptSuffix.length > 0) {
        await memory.addMessages(sessionId, promptSuffix);
      }

      if (preCompact) {
        await memory.compactIfNeeded(sessionId, {
          mode: "auto-pre",
          reason: "pre_sampling_compaction",
        });
      }
      markProcessedRun(promptRunsSeen, runKey);
    }

    const hydratedRaw = await memory.getPromptMessages(sessionId);
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
    const sessionId = await resolveSessionId(params);
    if (!sessionId) {
      return;
    }

    const runKey = await getRunKey(params, sessionId);
    if (!shouldProcessRun(generatedRunsSeen, runKey)) {
      return;
    }

    const generatedMessages = collectGeneratedMessages(result);
    const generatedUnique = uniqueWithinBatch(generatedMessages);
    if (generatedUnique.length > 0) {
      await memory.addMessages(sessionId, generatedUnique);
    }

    if (postCompact && shouldRunPostCompaction(result, postCompactStrategy)) {
      await memory.compactIfNeeded(sessionId, {
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
