import {
  jest,
  describe,
  test,
  expect,
  beforeAll,
  afterAll,
} from "@jest/globals";
import { MemoryLayer } from "../src/memory.js";

describe("MemoryLayer", () => {
  const mockModel: any = {
    specificationVersion: "v2",
    modelId: "mock-model",
    provider: "mock-provider",
    doGenerate: jest.fn<any>().mockResolvedValue({
      text: "Mocked summary",
      finishReason: "stop",
      usage: { promptTokens: 10, completionTokens: 5 },
      rawCall: { rawPrompt: "...", rawSettings: {} },
      content: [{ type: "text", text: "Mocked summary" }],
      warnings: [],
    }),
  };

  let memory: MemoryLayer;
  const sessionId = "test-session-" + Date.now();

  beforeAll(async () => {
    memory = new MemoryLayer({
      maxTokens: 50,
      summarizationModel: mockModel,
      threshold: 0.5,
    });
  });

  afterAll(async () => {
    await memory.clearSession(sessionId);
    await memory.dispose();
  });

  test("should add messages and retrieve history", async () => {
    await memory.addMessage(sessionId, "user", "Hello");
    const history = await memory.getMessages(sessionId);
    expect(history.length).toBe(1);
    expect(history[0]?.role).toBe("user");
    expect(history[0]?.content).toBe("Hello");
  });

  test("should trigger auto-summarization when threshold reached", async () => {
    // Current tokens roughly: Hello(1) + overhead(4) = 5. Threshold is 25.
    // Let's add more messages to reach > 25 tokens.
    await memory.addMessage(
      sessionId,
      "assistant",
      "This is a longer message that should significantly increase the token count for this session.",
    );
    await memory.addMessage(
      sessionId,
      "user",
      "And another message to be absolutely sure we cross the threshold.",
    );

    const history = await memory.getMessages(sessionId);

    // If summarization triggered, length should be 1 (system summary)
    expect(history.length).toBe(1);
    expect(history[0]?.role).toBe("system");
    expect(history[0]?.content).toContain("Summary");
    expect(history[0]?.content).toContain("Mocked summary");
  });

  test("clearSession should remove all messages for a session", async () => {
    await memory.clearSession(sessionId);
    const history = await memory.getMessages(sessionId);
    expect(history.length).toBe(0);
  });
});
