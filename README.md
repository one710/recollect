# @one710/recollect

[![Publish](https://github.com/one710/recollect/actions/workflows/publish.yml/badge.svg)](https://github.com/one710/recollect/actions/workflows/publish.yml)
[![npm version](https://img.shields.io/npm/v/@one710/recollect.svg)](https://www.npmjs.com/package/@one710/recollect)
[![npm downloads](https://img.shields.io/npm/dm/@one710/recollect.svg)](https://www.npmjs.com/package/@one710/recollect)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://github.com/one710/recollect/blob/main/LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-Ready-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

**Recollect** gives your AI agents "infinite memory" while keeping your context window lean and your bills low.

It's a provider-agnostic memory layer that automatically compacts long-running conversations into high-density summaries, protecting your core instructions while ensuring the agent never "forgets" the goal.

## 🚀 Why Use Recollect?

- **Universal Compatibility**: Works with any message schema. OpenAI, Anthropic, Gemini, or your own custom format—Recollect handles them all as generic dictionaries.
- **Recursive Summarization**: As history grows, Recollect merges old turns into a rolling thread of "checkpoint summaries," preserving intent without bloating tokens.
- **Instruction Guardrails**: Never lose your system prompt. Recollect intelligently protects "pinned" roles (like `system` or `developer`) from being summarized away.
- **Configurable Summary Roles**: Need summaries to be `system` messages? Or `developer` roles for o1/o3 models? Or even `user` messages? You decide.
- **Fast Persistence**: Built-in SQLite support for production-ready persistence, or a high-speed In-Memory adapter for ephemeral workers.

## 📦 Installation

```bash
npm install @one710/recollect
```

If you want persistent storage (recommended):

```bash
npm install sqlite3
```

## 🛠️ Quick Start

```typescript
import { MemoryLayer } from "@one710/recollect";

const memory = new MemoryLayer({
  maxTokens: 4096, // Maximum context budget
  // Mandatory: Use any tokenizer or simple length check
  countTokens: (msg) => JSON.stringify(msg).length / 4,
  // High-density summarizer callback
  summarize: async ({ summaryPrompt }) => {
    // Call your LLM here (OpenAI, Anthropic, local, etc.)
    return "The user is asking about building agentic systems...";
  },
});

const sessionId = "agent:researcher-1";

// Add arbitrary message shapes
await memory.addMessage(sessionId, {
  role: "user",
  content: "Analyze the latest trends in autonomous agents.",
});

// Retrieve the compact, ready-to-send prompt
const messages = await memory.getPromptMessages(sessionId);
```

## 🌍 Universal Provider Support

Because Recollect treats messages as generic objects, you can use it with any provider:

### OpenAI / Anthropic

```typescript
await memory.addMessage(id, { role: "assistant", content: "Understood." });
```

### Multimodal / Complex Content

```typescript
await memory.addMessage(id, {
  role: "user",
  content: [{ type: "image_url", image_url: { url: "..." } }],
});
```

## ⚙️ Advanced Configuration

| Option                  | Type                | Default          | Description                                            |
| :---------------------- | :------------------ | :--------------- | :----------------------------------------------------- |
| `maxTokens`             | `number`            | **Required**     | The token budget before compaction triggers.           |
| `countTokens`           | `TokenCounter`      | **Required**     | `(message: any) => number`. Your specific token logic. |
| `summarize`             | `SummarizeCallable` | **Required**     | Async function that performs the summarization.        |
| `summaryRole`           | `string`            | `"system"`       | Role assigned to generated summary messages.           |
| `threshold`             | `number`            | `0.9`            | Trigger compaction at 90% of `maxTokens`.              |
| `keepRecentUserTurns`   | `number`            | `4`              | Number of recent user turns to keep unsummarized.      |
| `keepRecentMessagesMin` | `number`            | `8`              | Minimum messages to keep at the tail of the history.   |
| `renderMessage`         | `MessageRenderer`   | `JSON.stringify` | Custom formatting for the summarizer's input.          |
| `storage`               | `Adapter`           | `SQLite`         | Persistent `sqlite3` or ephemeral `InMemory`.          |

## 🧪 Development

```bash
npm install
npm run build
npm test
```

## 📜 License

MIT © [one710](https://github.com/one710)
