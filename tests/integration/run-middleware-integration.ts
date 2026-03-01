/// <reference types="node" />

import { generateText, tool } from "ai";
import type { LanguageModel } from "ai";
import type { LanguageModelV3Message } from "@ai-sdk/provider";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { MemoryLayer } from "../../src/memory.js";
import { InMemoryStorageAdapter } from "../../src/storage.js";
import { withRecollectCompaction } from "../../src/ai-sdk.js";
import { SUMMARY_MESSAGE_PREFIX } from "../../src/summarizer.js";

interface IntegrationSuiteOptions {
  providerName: string;
  model: LanguageModel;
}

function assertCondition(
  condition: unknown,
  message: string,
): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function userMessage(text: string): LanguageModelV3Message {
  return { role: "user", content: [{ type: "text", text }] };
}

function assistantToolCallMessage(
  toolCallId: string,
  toolName: string,
  input: Record<string, unknown>,
): LanguageModelV3Message {
  return {
    role: "assistant",
    content: [
      {
        type: "tool-call",
        toolCallId,
        toolName,
        input: input as any,
      },
    ],
  };
}

function toolResultMessage(
  toolCallId: string,
  toolName: string,
  output: Record<string, unknown>,
): LanguageModelV3Message {
  return {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId,
        toolName,
        output: {
          type: "json",
          value: output as any,
        },
      },
    ],
  };
}

function countUserText(
  messages: LanguageModelV3Message[],
  text: string,
): number {
  return messages.filter((message) => {
    if (message.role !== "user") {
      return false;
    }
    if (typeof message.content === "string") {
      return message.content === text;
    }
    if (!Array.isArray(message.content)) {
      return false;
    }
    return message.content.some(
      (part: any) => part?.type === "text" && part.text === text,
    );
  }).length;
}

function countToolCall(
  messages: LanguageModelV3Message[],
  toolCallId: string,
): number {
  return messages.filter((message) => {
    if (message.role !== "assistant" || !Array.isArray(message.content)) {
      return false;
    }
    return message.content.some(
      (part: any) =>
        part?.type === "tool-call" && part.toolCallId === toolCallId,
    );
  }).length;
}

function countToolResult(
  messages: LanguageModelV3Message[],
  toolCallId: string,
): number {
  return messages.filter((message) => {
    if (message.role !== "tool" || !Array.isArray(message.content)) {
      return false;
    }
    return message.content.some(
      (part: any) =>
        part?.type === "tool-result" && part.toolCallId === toolCallId,
    );
  }).length;
}

async function runScenario(
  name: string,
  fn: () => Promise<void>,
): Promise<void> {
  process.stdout.write(`- ${name} ... `);
  await fn();
  process.stdout.write("ok\n");
}

export async function runMiddlewareIntegrationSuite(
  options: IntegrationSuiteOptions,
): Promise<void> {
  const { providerName, model } = options;
  const tools = {
    lookupMetric: tool({
      description: "Lookup a fake business metric by key.",
      inputSchema: z.object({ key: z.string() }),
      execute: async ({ key }: { key: string }) => ({
        key,
        value: key === "paid_subs_us_pct" ? 63.2 : 0,
      }),
    }),
  };

  const memory = new MemoryLayer({
    maxTokens: 50_000,
    summarizationModel: model,
    storage: new InMemoryStorageAdapter(),
  });
  const wrapped = withRecollectCompaction({
    model,
    memory,
    preCompact: true,
    postCompact: true,
    postCompactStrategy: "always",
  });

  const runTurn = async (args: {
    userId: string;
    messages: LanguageModelV3Message[];
    withTools?: boolean;
    sessionId?: string;
  }) => {
    return generateText({
      model: wrapped as any,
      messages: args.messages as any,
      ...(args.withTools ? { tools, maxSteps: 4 } : {}),
      providerOptions: {
        recollect: {
          userId: args.userId,
          sessionId: args.sessionId ?? randomUUID(),
        },
      },
    } as any);
  };

  console.log(`\nRunning middleware integration suite (${providerName})`);

  await runScenario("simple turn", async () => {
    const userId = `it-${providerName}-simple-${randomUUID()}`;
    const userText = "Explain compaction in one line.";
    await runTurn({
      userId,
      messages: [userMessage(userText)],
      sessionId: randomUUID(),
    });
    const history = await memory.getMessages(userId);
    assertCondition(
      countUserText(history, userText) === 1,
      "simple: user message missing",
    );
    assertCondition(
      history.some((message) => message.role === "assistant"),
      "simple: assistant message missing",
    );
  });

  await runScenario("multi turn with full history resend", async () => {
    const userId = `it-${providerName}-multi-${randomUUID()}`;
    const turn1 = "Give one sentence on long-chat memory.";
    await runTurn({
      userId,
      messages: [userMessage(turn1)],
      sessionId: randomUUID(),
    });
    const persistedAfterTurn1 = await memory.getMessages(userId);
    const turn2 = "Expand that into three bullets.";
    await runTurn({
      userId,
      messages: [...persistedAfterTurn1, userMessage(turn2)],
      sessionId: randomUUID(),
    });
    const history = await memory.getMessages(userId);
    assertCondition(
      countUserText(history, turn1) === 1,
      "multi: turn1 user duplicated or missing",
    );
    assertCondition(
      countUserText(history, turn2) === 1,
      "multi: turn2 user duplicated or missing",
    );
  });

  await runScenario("existing simple history", async () => {
    const userId = `it-${providerName}-existing-simple-${randomUUID()}`;
    await memory.addMessages(userId, [
      userMessage("Earlier question"),
      {
        role: "assistant",
        content: [{ type: "text", text: "Earlier answer" }],
      },
    ]);
    const followup = "Continue from the earlier answer.";
    await runTurn({
      userId,
      messages: [userMessage(followup)],
      sessionId: randomUUID(),
    });
    const history = await memory.getMessages(userId);
    assertCondition(
      countUserText(history, followup) === 1,
      "existing simple: followup missing",
    );
    assertCondition(
      history.some(
        (message) =>
          message.role === "assistant" &&
          Array.isArray(message.content) &&
          message.content.some(
            (part: any) =>
              part?.type === "text" && part.text === "Earlier answer",
          ),
      ),
      "existing simple: prior assistant message missing",
    );
  });

  await runScenario("existing tool-call history", async () => {
    const userId = `it-${providerName}-existing-tool-${randomUUID()}`;
    const toolCallId = `call-existing-${randomUUID().slice(0, 8)}`;
    await memory.addMessages(userId, [
      userMessage("Fetch paid_subs_us_pct"),
      assistantToolCallMessage(toolCallId, "lookupMetric", {
        key: "paid_subs_us_pct",
      }),
      toolResultMessage(toolCallId, "lookupMetric", {
        key: "paid_subs_us_pct",
        value: 63.2,
      }),
    ]);
    await runTurn({
      userId,
      messages: [userMessage("Explain that metric in one concise sentence.")],
      withTools: true,
      sessionId: randomUUID(),
    });
    const history = await memory.getMessages(userId);
    assertCondition(
      countToolCall(history, toolCallId) === 1,
      "existing tool history: seeded tool-call missing or duplicated",
    );
    assertCondition(
      countToolResult(history, toolCallId) === 1,
      "existing tool history: seeded tool-result missing or duplicated",
    );
    assertCondition(
      history.some((message) => message.role === "assistant"),
      "existing tool history: assistant output missing",
    );
  });

  await runScenario(
    "malformed existing history repaired by incoming prompt",
    async () => {
      const userId = `it-${providerName}-malformed-${randomUUID()}`;
      const toolCallId = `call-repair-${randomUUID().slice(0, 8)}`;
      const seededUser = "Run lookupMetric and continue";
      await memory.addMessages(userId, [
        userMessage(seededUser),
        assistantToolCallMessage(toolCallId, "lookupMetric", {
          key: "paid_subs_us_pct",
        }),
      ]);

      await runTurn({
        userId,
        messages: [
          userMessage(seededUser),
          assistantToolCallMessage(toolCallId, "lookupMetric", {
            key: "paid_subs_us_pct",
          }),
          toolResultMessage(toolCallId, "lookupMetric", {
            key: "paid_subs_us_pct",
            value: 63.2,
          }),
          userMessage("Now finish with one sentence."),
        ],
        withTools: true,
        sessionId: randomUUID(),
      });

      const history = await memory.getMessages(userId);
      assertCondition(
        countUserText(history, seededUser) === 1,
        "malformed repaired: seeded user duplicated",
      );
      assertCondition(
        countToolCall(history, toolCallId) === 1,
        "malformed repaired: tool-call duplicated or missing",
      );
      assertCondition(
        countToolResult(history, toolCallId) === 1,
        "malformed repaired: missing repaired tool-result",
      );
    },
  );

  await runScenario("missing assistant messages in prior history", async () => {
    const userId = `it-${providerName}-missing-assistant-${randomUUID()}`;
    const first = "Question without captured assistant reply #1";
    const second = "Question without captured assistant reply #2";
    const third = "Continue despite missing assistant turns.";
    await memory.addMessages(userId, [userMessage(first), userMessage(second)]);
    await runTurn({
      userId,
      messages: [userMessage(third)],
      sessionId: randomUUID(),
    });
    const history = await memory.getMessages(userId);
    assertCondition(
      countUserText(history, first) === 1 &&
        countUserText(history, second) === 1 &&
        countUserText(history, third) === 1,
      "missing assistant: user history incorrect",
    );
    assertCondition(
      history.some((message) => message.role === "assistant"),
      "missing assistant: did not recover with a new assistant message",
    );
  });

  await runScenario("run id retry idempotency", async () => {
    const userId = `it-${providerName}-run-idempotency-${randomUUID()}`;
    const sessionId = `run-${randomUUID()}`;
    const userText = "Reply with exactly: OK";

    await runTurn({
      userId,
      messages: [userMessage(userText)],
      sessionId,
    });

    // Simulate retry of the same run with identical run id.
    await runTurn({
      userId,
      messages: [userMessage(userText)],
      sessionId,
    });

    const history = await memory.getMessages(userId);
    const userCount = countUserText(history, userText);
    const assistantCount = history.filter(
      (message) => message.role === "assistant",
    ).length;
    assertCondition(
      userCount === 1,
      "run id idempotency: user ingested more than once",
    );
    assertCondition(
      assistantCount === 1,
      "run id idempotency: assistant ingested more than once",
    );
  });

  await runScenario(
    "repeated user text across different runs is preserved",
    async () => {
      const userId = `it-${providerName}-repeat-user-${randomUUID()}`;
      const repeated = "Hi";

      await runTurn({
        userId,
        messages: [userMessage(repeated)],
        sessionId: `run-${randomUUID()}`,
      });

      const historyAfterFirst = await memory.getMessages(userId);
      await runTurn({
        userId,
        messages: [...historyAfterFirst, userMessage(repeated)],
        sessionId: `run-${randomUUID()}`,
      });

      const history = await memory.getMessages(userId);
      const userCount = countUserText(history, repeated);
      assertCondition(
        userCount === 2,
        "repeat user: expected two distinct user messages with same text",
      );
    },
  );

  await runScenario("forced compaction with checkpoint summary", async () => {
    const compactionMemory = new MemoryLayer({
      maxTokens: 260,
      threshold: 0.55,
      keepRecentUserTurns: 2,
      keepRecentMessagesMin: 4,
      summarizationModel: model,
      storage: new InMemoryStorageAdapter(),
    });
    const compactionWrapped = withRecollectCompaction({
      model,
      memory: compactionMemory,
      preCompact: true,
      postCompact: true,
      postCompactStrategy: "always",
    });
    const userId = `it-${providerName}-compaction-${randomUUID()}`;
    const largeText =
      "Compaction candidate sentence: preserving intent, constraints, and unresolved work while reducing token volume. ";

    const seedHistory: LanguageModelV3Message[] = [];
    for (let i = 0; i < 8; i += 1) {
      seedHistory.push(
        userMessage(`Seed user ${i + 1}: ${largeText.repeat(8)}`),
        {
          role: "assistant",
          content: [
            {
              type: "text",
              text: `Seed assistant ${i + 1}: ${largeText.repeat(8)}`,
            },
          ],
        },
      );
    }
    await compactionMemory.addMessages(userId, seedHistory);

    await generateText({
      model: compactionWrapped as any,
      messages: [
        userMessage("Continue after compaction with one concise line.") as any,
      ],
      providerOptions: { recollect: { userId, sessionId: randomUUID() } },
    } as any);

    const events = await compactionMemory.getSessionEvents(userId, 200);
    const snapshot = await compactionMemory.getSessionSnapshot(userId);
    const hasAppliedCompaction = events.some(
      (event) => event.type === "compaction_applied",
    );
    const hasSummaryMessage = snapshot.messages.some(
      (message) =>
        message.role === "system" &&
        typeof message.content === "string" &&
        message.content.startsWith(SUMMARY_MESSAGE_PREFIX),
    );

    assertCondition(
      hasAppliedCompaction,
      "compaction: no compaction_applied event observed",
    );
    assertCondition(
      hasSummaryMessage,
      "compaction: no checkpoint summary system message observed",
    );
    assertCondition(
      snapshot.stats.compactionCount > 0,
      "compaction: stats.compactionCount did not increase",
    );

    await compactionMemory.dispose();
  });

  await memory.dispose();
  console.log(`\nIntegration suite passed (${providerName})`);
}
