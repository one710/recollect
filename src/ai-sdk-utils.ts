import type { LanguageModelV3Message } from "@ai-sdk/provider";

function parseJsonObject(input: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(input);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Keep original value if parsing fails.
  }
  return null;
}

function normalizeToolCallInputs(
  message: LanguageModelV3Message,
): LanguageModelV3Message {
  if (!Array.isArray(message.content)) {
    return message;
  }

  let changed = false;
  const normalizedContent = message.content.map((part: any) => {
    if (part?.type !== "tool-call" || typeof part?.input !== "string") {
      return part;
    }

    const parsed = parseJsonObject(part.input);
    if (!parsed) {
      return part;
    }

    changed = true;
    return {
      ...part,
      input: parsed,
    };
  });

  if (!changed) {
    return message;
  }

  return {
    ...message,
    content: normalizedContent as any,
  };
}

function normalizeMessageForMemory(
  message: LanguageModelV3Message,
): LanguageModelV3Message | null {
  let normalized = normalizeToolCallInputs(message);

  // Providers can surface user/assistant text as either string or content parts.
  // Canonicalize to text parts so overlap detection is stable across calls.
  if (
    typeof normalized.content === "string" &&
    (normalized.role === "user" || normalized.role === "assistant")
  ) {
    normalized = {
      ...normalized,
      content: [{ type: "text", text: normalized.content }],
    } as LanguageModelV3Message;
  }

  if (!Array.isArray(normalized.content)) {
    return normalized;
  }

  const filteredContent = normalized.content.filter(
    (part: any) => part?.type !== "reasoning",
  );
  if (filteredContent.length === 0) {
    return null;
  }

  return {
    ...normalized,
    content: filteredContent as any,
  };
}

function canonicalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalizeJson);
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(
      ([a], [b]) => a.localeCompare(b),
    );
    const next: Record<string, unknown> = {};
    for (const [key, child] of entries) {
      next[key] = canonicalizeJson(child);
    }
    return next;
  }
  return value;
}

function canonicalizePart(part: any): unknown {
  if (!part || typeof part !== "object") {
    return part;
  }
  switch (part.type) {
    case "text":
      return { type: "text", text: part.text ?? "" };
    case "tool-call":
      return {
        type: "tool-call",
        toolCallId: part.toolCallId ?? "",
        toolName: part.toolName ?? "",
        input: canonicalizeJson(part.input),
      };
    case "tool-result":
      return {
        type: "tool-result",
        toolCallId: part.toolCallId ?? "",
        toolName: part.toolName ?? "",
        output: canonicalizeJson((part as any).output ?? (part as any).result),
      };
    case "file":
      return {
        type: "file",
        filename: part.filename ?? null,
        mediaType: part.mediaType ?? null,
      };
    default:
      return canonicalizeJson(part);
  }
}

function canonicalizeMessageForComparison(
  message: LanguageModelV3Message,
): unknown {
  const normalized = normalizeMessageForMemory(message);
  if (!normalized) {
    return null;
  }
  if (!Array.isArray(normalized.content)) {
    return {
      role: normalized.role,
      content: normalized.content,
    };
  }
  return {
    role: normalized.role,
    content: normalized.content.map(canonicalizePart),
  };
}

function fingerprintMessage(message: LanguageModelV3Message): string | null {
  const canonical = canonicalizeMessageForComparison(message);
  if (!canonical) {
    return null;
  }
  return JSON.stringify(canonical);
}

export function normalizeMessages(
  messages: LanguageModelV3Message[],
): LanguageModelV3Message[] {
  const normalized: LanguageModelV3Message[] = [];
  for (const message of messages) {
    const next = normalizeMessageForMemory(message);
    if (next) {
      normalized.push(next);
    }
  }
  return normalized;
}

export function uniqueWithinBatch(
  messages: LanguageModelV3Message[],
): LanguageModelV3Message[] {
  const unique: LanguageModelV3Message[] = [];
  const seen = new Set<string>();
  for (const message of normalizeMessages(messages)) {
    const key = fingerprintMessage(message);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(message);
  }
  return unique;
}

export function findPromptSuffixToAppend(
  existingMessages: LanguageModelV3Message[],
  promptMessages: LanguageModelV3Message[],
): LanguageModelV3Message[] {
  const existing = normalizeMessages(existingMessages);
  const prompt = normalizeMessages(promptMessages);
  if (prompt.length === 0) {
    return [];
  }

  const existingKeys = existing
    .map((message) => fingerprintMessage(message))
    .filter((key): key is string => Boolean(key));
  const promptKeys = prompt
    .map((message) => fingerprintMessage(message))
    .filter((key): key is string => Boolean(key));
  const maxOverlap = Math.min(existingKeys.length, promptKeys.length);

  let overlap = 0;
  for (let size = maxOverlap; size > 0; size -= 1) {
    let matches = true;
    for (let i = 0; i < size; i += 1) {
      const existingKey = existingKeys[existingKeys.length - size + i];
      const promptKey = promptKeys[i];
      if (existingKey !== promptKey) {
        matches = false;
        break;
      }
    }
    if (matches) {
      overlap = size;
      break;
    }
  }

  return prompt.slice(overlap);
}

export function collectGeneratedMessages(
  result: unknown,
): LanguageModelV3Message[] {
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

export function shouldRunPostCompaction(
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
