/// <reference types="node" />

import { runMiddlewareIntegrationSuite } from "./run-middleware-integration.js";

async function main() {
  if (!process.env.AWS_REGION) {
    throw new Error(
      "AWS_REGION is required. Run: AWS_REGION=... npm run test:integration:bedrock",
    );
  }

  let createAmazonBedrock: (
    options?: Record<string, unknown>,
  ) => (modelId: string) => any;
  try {
    const mod = await import("@ai-sdk/amazon-bedrock");
    createAmazonBedrock = mod.createAmazonBedrock;
  } catch {
    throw new Error(
      "Missing @ai-sdk/amazon-bedrock. Install with: npm install -D @ai-sdk/amazon-bedrock",
    );
  }

  const modelId =
    process.env.RECOLLECT_BEDROCK_MODEL ||
    "arn:aws:bedrock:eu-west-1:961354904951:inference-profile/eu.anthropic.claude-sonnet-4-5-20250929-v1:0";
  const bedrock = createAmazonBedrock({
    region: process.env.AWS_REGION,
    apiKey: process.env.AWS_BEARER_TOKEN_BEDROCK,
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    sessionToken: process.env.AWS_SESSION_TOKEN,
  });

  await runMiddlewareIntegrationSuite({
    providerName: `bedrock:${modelId}`,
    model: bedrock(modelId),
  });
}

main().catch((error) => {
  console.error("Bedrock integration failed:", error);
  process.exitCode = 1;
});
