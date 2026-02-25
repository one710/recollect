# @one710/recollect

Recollect is a memory layer for AI agents that provides auto-summarizing chat history. It ensures that conversation context remains within model limits by automatically summarizing messages when a token threshold is reached.

## Features

- **Auto-Summarization**: Automatically replaces conversation history with a system summary when tokens reach a defined threshold (default 90%).
- **Full Message History**: Supports complex [AI SDK](https://ai-sdk.dev/) message types (`ModelMessage`), including multi-part content (text, images, files), tool calls, and tool results.
- **Session-Based**: Manage multiple independent conversations using unique session IDs.
- **Provider Agnostic**: Works with any LLM provider supported by many AI SDK.
- **Fast Token Counting**: Uses [ai-tokenizer](https://github.com/coder/ai-tokenizer) by default, but supports custom implementations.
- **Persistent Storage**: Uses Node.js's native `node:sqlite` with zero external dependencies.

## Installation

```bash
# Using npm
npm install @one710/recollect

# Using yarn
yarn add @one710/recollect
```

## Usage

```typescript
import { MemoryLayer } from "@one710/recollect";
import { openai } from "@ai-sdk/openai";

const memory = new MemoryLayer({
  maxTokens: 4096,
  summarizationModel: openai("gpt-4o-mini"),
  threshold: 0.9, // Summarize at 90% of maxTokens
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

## Configuration

The `MemoryLayer` constructor accepts the following options:

- `maxTokens`: (Required) The maximum number of tokens allowed in history.
- `summarizationModel`: (Required) The AI SDK model used to generate summaries.
- `threshold`: (Optional) The percentage (0.0 to 1.0) of `maxTokens` that triggers summarization. Defaults to `0.9`.
- `countTokens`: (Optional) A custom function `(text: string) => number` to count tokens. Defaults to the internal `ai-tokenizer` logic.
- `databasePath`: (Optional) Path to the SQLite database.

### memory.addMessage(sessionId, role?, contentOrMessage)

Adds a message to the chat history.

- `sessionId`: (Required) The session ID for the conversation.
- `role`: (Optional) The message role (`user`, `assistant`, `system`, etc.). If `null`, `contentOrMessage` must be a full AI SDK message object.
- `contentOrMessage`: (Required) Either a string (if `role` is provided) or a full `ModelMessage` object (if `role` is `null`).

### memory.getMessages(sessionId)

Returns the full chat history for a session as an array of `ModelMessage`.

- Node.js v22.5.0 or higher (for native `node:sqlite` support)
- SQLite (built-in to Node.js)

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
