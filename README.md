# @one710/recollect

Recollect is a memory layer for AI agents that provides auto-summarizing chat history. It ensures that conversation context remains within model limits by automatically summarizing messages when a token threshold is reached.

## Features

- **Auto-Summarization**: Automatically replaces conversation history with a system summary when tokens reach a defined threshold (default 90%).
- **Session-Based**: Required `sessionId` for all chat items to manage multiple independent conversations.
- **Provider Agnostic**: Built on [AI SDK](https://ai-sdk.dev/) for compatibility with various LLM providers.
- **Fast Token Counting**: Uses [ai-tokenizer](https://github.com/coder/ai-tokenizer) for high-performance token estimation.
- **Persistent Storage**: Uses Node.js's native `node:sqlite` for simple and reliable storage with zero external database dependencies.

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

// Add messages
await memory.addMessage(sessionId, "user", "What is the capital of France?");
await memory.addMessage(
  sessionId,
  "assistant",
  "The capital of France is Paris.",
);

// Fetch chat history
const history = await memory.getMessages(sessionId);
console.log(history);
```

## Configuration

The `MemoryLayer` constructor accepts the following options:

- `maxTokens`: (Required) The maximum number of tokens allowed in history.
- `summarizationModel`: (Required) The AI SDK model used to generate summaries.
- `threshold`: (Optional) The percentage (0.0 to 1.0) of `maxTokens` that triggers summarization. Defaults to `0.9`.

## Development

### Prerequisites

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
