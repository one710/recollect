# @one710/recollect

[![Publish](https://github.com/one710/recollect/actions/workflows/publish.yml/badge.svg)](https://github.com/one710/recollect/actions/workflows/publish.yml)
[![npm version](https://img.shields.io/npm/v/@one710/recollect.svg)](https://www.npmjs.com/package/@one710/recollect)
[![npm downloads](https://img.shields.io/npm/dm/@one710/recollect.svg)](https://www.npmjs.com/package/@one710/recollect)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://github.com/one710/recollect/blob/main/LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-Ready-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

Recollect is a memory + compaction layer for long-running AI SDK chats.

It keeps full session history, automatically compacts older context when needed, and preserves recent turns and instruction context so your app stays coherent as conversations grow.

## Why Recollect

- Works with AI SDK `LanguageModelV3Message` shapes (user/assistant/system/tool, multi-part content, tool calls/results)
- Session-based memory with pluggable storage
- Robust compaction strategy with summary checkpoints
- Middleware that can auto-manage prompt/history lifecycle around `generateText`
- Provider-agnostic (tested with OpenAI and Bedrock integration suites)

## Installation

```bash
npm install @one710/recollect
```

If you want SQLite persistence:

```bash
npm install sqlite3
```

If you only use `InMemoryStorageAdapter`, `sqlite3` is not required.

## Quick Start (Manual Memory API)

```typescript
import { MemoryLayer } from "@one710/recollect";
import { openai } from "@ai-sdk/openai";

const memory = new MemoryLayer({
  maxTokens: 8192,
  summarizationModel: openai("gpt-4o-mini"),
});

const sessionId = "chat:user-123";

await memory.addMessage(sessionId, "user", "What should we build next?");
await memory.addMessage(
  sessionId,
  "assistant",
  "Let's prioritize onboarding improvements.",
);

await memory.addMessage(sessionId, null, {
  role: "assistant",
  content: [
    {
      type: "tool-call",
      toolCallId: "call-1",
      toolName: "lookupMetric",
      input: { key: "paid_subs_us_pct" } as any,
    },
  ],
});

await memory.addMessage(sessionId, null, {
  role: "tool",
  content: [
    {
      type: "tool-result",
      toolCallId: "call-1",
      toolName: "lookupMetric",
      output: { type: "json", value: { key: "paid_subs_us_pct", value: 63.2 } },
    },
  ],
});

const history = await memory.getMessages(sessionId);
console.log(history.length);
```

## AI SDK Middleware (Automatic Mode)

`withRecollectCompaction(...)` can automatically:

1. ingest unseen incoming prompt messages
2. run optional pre-compaction (`auto-pre`)
3. hydrate the model prompt from memory
4. ingest generated assistant/tool messages from model output
5. run optional post-compaction (`auto-post`)

```typescript
import { generateText } from "ai";
import { openai } from "@ai-sdk/openai";
import { MemoryLayer, withRecollectCompaction } from "@one710/recollect";

const memory = new MemoryLayer({
  maxTokens: 8192,
  summarizationModel: openai("gpt-4o-mini"),
});

const model = withRecollectCompaction({
  model: openai("gpt-4o-mini"),
  memory,
  preCompact: true,
  postCompact: true,
  postCompactStrategy: "follow-up-only", // or "always"
});

await generateText({
  model,
  messages: [{ role: "user", content: "Continue." }],
  providerOptions: {
    recollect: {
      userId: "user-123",
      sessionId: "run-2026-03-01-001",
    },
  },
});
```

### Session ID Resolution

By default, middleware reads:

- `providerOptions.recollect.userId` as conversation identity
- `providerOptions.recollect.sessionId` as run identity (idempotency per run)

You can override via `resolveUserId(params)` and `resolveSessionId(params)`.

## API Overview

### `MemoryLayer` options

- `maxTokens` (required)
- `summarizationModel` (required)
- `threshold` (default `0.9`)
- `targetTokensAfterCompaction` (default `65%` of `maxTokens`)
- `keepRecentUserTurns` (default `4`)
- `keepRecentMessagesMin` (default `8`)
- `maxCompactionPasses` (default `3`)
- `minimumMessagesToCompact` (default `6`)
- `countTokens` (optional custom tokenizer)
- `storage` (optional custom adapter)
- `databasePath` (used only when `storage` is not provided)
- `onCompactionEvent` (optional diagnostics hook)

### `MemoryLayer` methods

- `addMessage(sessionId, role, contentOrMessage)`
- `addMessages(sessionId, messages)`
- `getMessages(sessionId)`
- `getPromptMessages(sessionId)`
- `compactNow(sessionId)`
- `compactIfNeeded(sessionId, options)`
- `getSessionEvents(sessionId, limit?)`
- `getSessionSnapshot(sessionId)`
- `clearSession(sessionId)`
- `dispose()`

## Storage

Exports:

- `InMemoryStorageAdapter`
- `createSQLiteStorageAdapter(databasePath)`
- `MemoryStorageAdapter` type (for custom adapters)

## Integration Testing (Manual, Real Providers)

These are provider-backed integration runs (not unit tests):

```bash
npm run test:integration:openai
npm run test:integration:bedrock
```

### Required env vars

OpenAI:

- `OPENAI_API_KEY`
- optional: `RECOLLECT_OPENAI_MODEL` (default `gpt-5-nano`)

Bedrock:

- `AWS_REGION`
- `AWS_ACCESS_KEY_ID`
- `AWS_SECRET_ACCESS_KEY`
- optional: `AWS_SESSION_TOKEN`
- optional: `AWS_BEARER_TOKEN_BEDROCK`
- optional: `RECOLLECT_BEDROCK_MODEL`

### Covered scenarios

- simple turn
- multi-turn with full-history resend
- existing simple history
- existing tool-call history
- malformed existing history (tool-call without prior tool-result)
- missing assistant messages in prior history
- forced compaction with checkpoint summary validation

## Development

```bash
npm install
npm run build
npm test
```

## License

MIT
