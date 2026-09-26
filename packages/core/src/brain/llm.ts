import Anthropic from "@anthropic-ai/sdk";
import { AnthropicBedrockMantle } from "@anthropic-ai/bedrock-sdk";
import { env } from "../config.js";

export type LlmClient = Anthropic;

let cached: LlmClient | undefined;

/**
 * Anthropic first-party for local dev (ANTHROPIC_API_KEY), Bedrock Mantle in
 * AWS so the credits pay for tokens. Both expose the same messages surface.
 */
export function llm(): LlmClient {
  if (cached) return cached;
  const provider = process.env.LLM_PROVIDER ?? (process.env.ANTHROPIC_API_KEY ? "anthropic" : "bedrock");
  cached = provider === "bedrock"
    ? (new AnthropicBedrockMantle({ awsRegion: env.region }) as unknown as Anthropic)
    : new Anthropic();
  return cached;
}

export function modelId(): string {
  const base = process.env.LLM_MODEL ?? "claude-opus-5";
  const provider = process.env.LLM_PROVIDER ?? (process.env.ANTHROPIC_API_KEY ? "anthropic" : "bedrock");
  if (provider === "bedrock" && !base.startsWith("anthropic.")) return `anthropic.${base}`;
  return base;
}

/** Cheap model for yes/no classification. */
export function cheapModelId(): string {
  const base = process.env.LLM_CHEAP_MODEL ?? "claude-haiku-4-5";
  const provider = process.env.LLM_PROVIDER ?? (process.env.ANTHROPIC_API_KEY ? "anthropic" : "bedrock");
  return provider === "bedrock" && !base.startsWith("anthropic.") ? `anthropic.${base}` : base;
}

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export function textOf(msg: Anthropic.Message | Anthropic.Beta.BetaMessage): string {
  return msg.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

export function assertNotRefused(msg: { stop_reason: string | null }) {
  if (msg.stop_reason === "refusal") throw new Error("Model refused the request");
}
