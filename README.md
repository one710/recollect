# @one710/recollect

Recollect is a memory layer for AI agents that provides robust context compaction for long-running chats. It keeps conversation state within model limits by summarizing older history while preserving recent turns and instruction context.

## Features

- **Robust Auto-Compaction**: Summarizes only the older slice of history and preserves recent turns for continuity.
- **Full Message History**: Supports complex [AI SDK](https://ai-sdk.dev/) message types (`ModelMessage`), including multi-part content (text, images, files), tool calls, and tool results.
- **Session-Based**: Manage multiple independent conversations using unique session IDs.
- **Provider Agnostic**: Works with any LLM provider supported by the AI SDK.
- **Fast Token Counting**: Uses [ai-tokenizer](https://github.com/coder/ai-tokenizer) by default, but supports custom implementations.
- **Persistent Storage**: Uses `sqlite3` for reliable storage with zero external database server dependencies.
- **Compaction Stability**: Merges prior summaries into new summaries to avoid summary loss across repeated compactions.
- **Pluggable Storage Adapters**: Use built-in SQLite or in-memory adapters, or provide your own adapter.
- **AI SDK Model Wrapper**: `withRecollectMemory(...)` wraps models so prompts are hydrated from memory automatically.
- **Pre/Post Sampling Compaction**: Middleware can compact before model calls and after follow-up-producing outputs.
- **Session Replay + Diagnostics**: Durable session events and stats for inspection/resume debugging.

## Installation

```bash
# Using npm
npm install @one710/recollect

# Using yarn
yarn add @one710/recollect
```

If you plan to use the default SQLite storage, also install:

```bash
npm install sqlite3
```

If you only use `InMemoryStorageAdapter`, `sqlite3` is not required.

## Usage

```typescript
import { MemoryLayer } from "@one710/recollect";
import { openai } from "@ai-sdk/openai";

const memory = new MemoryLayer({
  maxTokens: 4096,
  summarizationModel: openai("gpt-4o-mini"),
  threshold: 0.9, // Summarize at 90% of maxTokens
  keepRecentUserTurns: 4, // preserve recent turn boundaries
  keepRecentMessagesMin: 8, // preserve a minimum recency window
});

const sessionId = "user-123-chat-456";

// Add messages using role and content
await memory.addMessage(sessionId, "user", "What is the capital of France?");
await memory.addMessage(
  sessionId,
  "assistant",
  "The capital of France is Paris.",
);

// Add complex messages using full AI SDK message objects
await memory.addMessage(sessionId, null, {
  role: "user",
  content: [
    { type: "text", text: "What is in this image?" },
    { type: "image", image: "https://example.com/image.png" },
  ],
});

// Supports tool calls and tool results automatically
await memory.addMessage(sessionId, null, {
  role: "assistant",
  content: "Let me check the weather.",
  toolCalls: [
    {
      type: "tool-call",
      toolCallId: "call-1",
      toolName: "getWeather",
      args: { city: "Paris" },
    },
  ],
});

// Fetch chat history (returns ModelMessage[])
const history = await memory.getMessages(sessionId);
console.log(history);
```

### AI SDK Wrapper

```typescript
import { generateText } from "ai";
import { openai } from "@ai-sdk/openai";
import { MemoryLayer, withRecollectMemory } from "@one710/recollect";

const memory = new MemoryLayer({
  maxTokens: 8192,
  summarizationModel: openai("gpt-4o-mini"),
});

const model = withRecollectMemory({
  model: openai("gpt-4o-mini"),
  memory,
});

const result = await generateText({
  model,
  messages: [{ role: "user", content: "Summarize our last decisions" }],
  providerOptions: {
    recollect: { sessionId: "user-123-chat-456" },
  },
});
```

## Configuration

The `MemoryLayer` constructor accepts the following options:

- `maxTokens`: (Required) The maximum number of tokens allowed in history.
- `summarizationModel`: (Required) The AI SDK model used to generate summaries.
- `threshold`: (Optional) The percentage (0.0 to 1.0) of `maxTokens` that triggers summarization. Defaults to `0.9`.
- `countTokens`: (Optional) A custom function `(text: string) => number` to count tokens. Defaults to the internal `ai-tokenizer` logic.
- `databasePath`: (Optional) Path to the SQLite database.
- `storage`: (Optional) Custom storage adapter implementing `MemoryStorageAdapter`.
- `targetTokensAfterCompaction`: (Optional) Target token budget after compaction. Defaults to `65%` of `maxTokens`.
- `keepRecentUserTurns`: (Optional) Number of latest user turns to preserve verbatim. Defaults to `4`.
- `keepRecentMessagesMin`: (Optional) Minimum count of latest messages to preserve. Defaults to `8`.
- `maxCompactionPasses`: (Optional) Maximum compaction passes per write. Defaults to `3`.
- `minimumMessagesToCompact`: (Optional) Do not compact below this session size. Defaults to `6`.

### memory.addMessage(sessionId, role?, contentOrMessage)

Adds a message to the chat history.

- `sessionId`: (Required) The session ID for the conversation.
- `role`: (Optional) The message role (`user`, `assistant`, `system`, etc.). If `null`, `contentOrMessage` must be a full AI SDK message object.
- `contentOrMessage`: (Required) Either a string (if `role` is provided) or a full `ModelMessage` object (if `role` is `null`).

### memory.getMessages(sessionId)

Returns the full chat history for a session as an array of `ModelMessage`.

### memory.compactNow(sessionId)

Forces an immediate compaction pass, useful before a model switch to a smaller context window.

### memory.compactIfNeeded(sessionId, options)

Runs compaction in a specific mode (`manual`, `auto-pre`, `auto-post`, `ingest`) and reason.

### memory.getSessionEvents(sessionId, limit?)

Returns session events such as message ingest, normalization, compaction start, and compaction apply.

### memory.getSessionSnapshot(sessionId)

Returns current messages, token count, and persisted compaction stats.

## Storage Adapters

Recollect exports:

- `SQLiteStorageAdapter` (default)
- `InMemoryStorageAdapter` (helpful for tests)

You can provide your own adapter by implementing `MemoryStorageAdapter`.

## Development

### Prerequisites

- Node.js v18 or higher
- SQLite (via `sqlite3` npm package)

### Setup

```bash
yarn
yarn build
```

### Running Tests

```bash
yarn test
```

## License

MIT
