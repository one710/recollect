/// <reference types="node" />

import { runMiddlewareIntegrationSuite } from "./run-middleware-integration.js";

async function main() {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error(
      "OPENAI_API_KEY is required. Run: OPENAI_API_KEY=... npm run test:integration:openai",
    );
  }

  let openai: (modelId: string) => any;
  try {
    const mod = await import("@ai-sdk/openai");
    openai = mod.openai;
  } catch {
    throw new Error(
      "Missing @ai-sdk/openai. Install with: npm install -D @ai-sdk/openai",
    );
  }

  const modelId = process.env.RECOLLECT_OPENAI_MODEL || "gpt-5-nano";
  await runMiddlewareIntegrationSuite({
    providerName: `openai:${modelId}`,
    model: openai(modelId),
  });
}

main().catch((error) => {
  console.error("OpenAI integration failed:", error);
  process.exitCode = 1;
});
