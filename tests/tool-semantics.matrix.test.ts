import { describe, test, expect } from "@jest/globals";
import { MemoryLayer } from "../src/memory.js";
import { InMemoryStorageAdapter } from "../src/storage.js";
import type { ModelMessage } from "ai";

const mockModel: any = {
  specificationVersion: "v3",
  modelId: "mock-model",
  provider: "mock-provider",
  doGenerate: async () => ({
    text: "Mocked summary",
    content: [{ type: "text", text: "Mocked summary" }],
    finishReason: "stop",
    usage: {
      inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 5, text: 5, reasoning: 0 },
    },
    warnings: [],
    rawCall: { rawPrompt: "...", rawSettings: {} },
  }),
};

function toolParts(prompt: ModelMessage[]): any[] {
  return prompt
    .filter((message: any) => message.role === "tool")
    .flatMap((message: any) =>
      Array.isArray(message.content) ? message.content : [],
    );
}

function countMissing(parts: any[]): number {
  return parts.filter(
    (part) =>
      part.type === "tool-result" && part.result?.status === "missing_result",
  ).length;
}

function countByCallId(parts: any[], callId: string): number {
  return parts.filter(
    (part) => part.type === "tool-result" && part.toolCallId === callId,
  ).length;
}

describe("Tool Semantics Matrix", () => {
  const cases: Array<{
    name: string;
    messages: ModelMessage[];
    expectMissing: number;
    expectCallCounts: Record<string, number>;
  }> = [
    {
      name: "assistant.toolCalls without result synthesizes one missing result",
      messages: [
        { role: "user", content: "Run tool A" } as any,
        {
          role: "assistant",
          content: "Calling tool A",
          toolCalls: [
            {
              type: "tool-call",
              toolCallId: "call-a",
              toolName: "toolA",
              args: {},
            },
          ],
        } as any,
      ],
      expectMissing: 1,
      expectCallCounts: { "call-a": 1 },
    },
    {
      name: "matching tool result prevents synthetic missing result",
      messages: [
        { role: "user", content: "Run tool A" } as any,
        {
          role: "assistant",
          content: "Calling tool A",
          toolCalls: [
            {
              type: "tool-call",
              toolCallId: "call-a",
              toolName: "toolA",
              args: {},
            },
          ],
        } as any,
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "call-a",
              toolName: "toolA",
              result: { ok: true },
            },
          ],
        } as any,
      ],
      expectMissing: 0,
      expectCallCounts: { "call-a": 1 },
    },
    {
      name: "orphan tool results are dropped",
      messages: [
        { role: "user", content: "No call happened" } as any,
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "orphan-call",
              toolName: "ghostTool",
              result: { ok: false },
            },
          ],
        } as any,
      ],
      expectMissing: 0,
      expectCallCounts: { "orphan-call": 0 },
    },
    {
      name: "mixed known + orphan results keep known and drop orphan",
      messages: [
        { role: "user", content: "Run tool A" } as any,
        {
          role: "assistant",
          content: "Calling tool A",
          toolCalls: [
            {
              type: "tool-call",
              toolCallId: "call-a",
              toolName: "toolA",
              args: {},
            },
          ],
        } as any,
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "call-a",
              toolName: "toolA",
              result: { ok: true },
            },
            {
              type: "tool-result",
              toolCallId: "orphan-call",
              toolName: "ghostTool",
              result: { ok: false },
            },
          ],
        } as any,
      ],
      expectMissing: 0,
      expectCallCounts: { "call-a": 1, "orphan-call": 0 },
    },
    {
      name: "assistant content-part tool-call is recognized",
      messages: [
        { role: "user", content: "Run content-part tool call" } as any,
        {
          role: "assistant",
          content: [
            { type: "text", text: "Invoking tool via content part." },
            {
              type: "tool-call",
              toolCallId: "call-part",
              toolName: "toolPart",
              args: { v: 1 },
            },
          ],
        } as any,
      ],
      expectMissing: 1,
      expectCallCounts: { "call-part": 1 },
    },
    {
      name: "assistant content-part tool-result counts as resolved",
      messages: [
        { role: "user", content: "Run content-part call + result" } as any,
        {
          role: "assistant",
          content: [
            { type: "text", text: "Inline call + result." },
            {
              type: "tool-call",
              toolCallId: "call-inline",
              toolName: "toolInline",
              args: {},
            },
            {
              type: "tool-result",
              toolCallId: "call-inline",
              toolName: "toolInline",
              result: { ok: true },
            },
          ],
        } as any,
      ],
      expectMissing: 0,
      expectCallCounts: { "call-inline": 0 },
    },
    {
      name: "multiple calls with partial resolution synthesizes only unresolved",
      messages: [
        { role: "user", content: "Run tool A and B" } as any,
        {
          role: "assistant",
          content: "Calling tools",
          toolCalls: [
            {
              type: "tool-call",
              toolCallId: "call-a",
              toolName: "toolA",
              args: {},
            },
            {
              type: "tool-call",
              toolCallId: "call-b",
              toolName: "toolB",
              args: {},
            },
          ],
        } as any,
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "call-a",
              toolName: "toolA",
              result: { ok: true },
            },
          ],
        } as any,
      ],
      expectMissing: 1,
      expectCallCounts: { "call-a": 1, "call-b": 1 },
    },
  ];

  for (const matrixCase of cases) {
    test(matrixCase.name, async () => {
      const session = `tool-matrix-${Date.now()}-${matrixCase.name.replace(/\s+/g, "-")}`;
      const memory = new MemoryLayer({
        maxTokens: 1000,
        summarizationModel: mockModel,
        storage: new InMemoryStorageAdapter(),
      });

      await memory.addMessages(session, matrixCase.messages);
      const prompt = await memory.getPromptMessages(session);
      const parts = toolParts(prompt);

      expect(countMissing(parts)).toBe(matrixCase.expectMissing);
      for (const [callId, expectedCount] of Object.entries(
        matrixCase.expectCallCounts,
      )) {
        expect(countByCallId(parts, callId)).toBe(expectedCount);
      }

      // Idempotency check for every matrix case.
      const prompt2 = await memory.getPromptMessages(session);
      expect(prompt2).toEqual(prompt);

      await memory.dispose();
    });
  }
});
