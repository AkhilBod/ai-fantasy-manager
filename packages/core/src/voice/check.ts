import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { llm, modelId, assertNotRefused } from "../brain/llm.js";
import type { VoiceBundle } from "./types.js";
import { loadRules } from "../config.js";

const Verdict = z.object({
  score: z.number().min(0).max(10).describe("10 = indistinguishable from the real person"),
  tells: z.array(z.string()).describe("specific things that give it away as not them / as AI"),
  clear: z.boolean().describe("would the recipient understand exactly what is being asked or said? false if garbled, cryptic, or missing the point"),
});

export interface DraftCheck { pass: boolean; score: number; feedback: string }

/** Hard checks first (cheap), then an LLM judge against the few-shots. */
export function hardLimits(bundle: VoiceBundle) {
  const rules = loadRules();
  return { maxWords: Math.min(Math.ceil(bundle.profile.lengthWords.p90 * 1.2), rules.maxMessageWords), maxLines: rules.maxMessageLines, banned: rules.bannedWords };
}

export function bannedIn(text: string, banned: string[]): string[] {
  return banned.filter((w) => new RegExp(`(^|[^a-z])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z]|$)`, "i").test(text));
}

export async function checkDraft(bundle: VoiceBundle, text: string): Promise<DraftCheck> {
  const p = bundle.profile;
  const words = text.trim().split(/\s+/).length;
  const lines = text.trim().split(/\n+/).length;
  const { maxWords, maxLines, banned } = hardLimits(bundle);
  const hard: string[] = [];
  if (words > maxWords) hard.push(`too long (${words} words, cap ${maxWords})`);
  if (lines > maxLines) hard.push(`too many lines (${lines}, cap ${maxLines}); one short text`);
  const bad = bannedIn(text, banned);
  if (bad.length) hard.push(`uses banned word(s): ${bad.join(", ")}`);
  if (p.casing === "lowercase" && /^[A-Z]/.test(text) && !/^[A-Z]{2,}/.test(text)) hard.push("starts with a capital letter but they text lowercase");
  if (/\b(AI|assistant|bot|language model)\b/i.test(text)) hard.push("mentions AI/bot");
  if (/\b(nah|no|lol|lmao+)?\s*(its|it's|thats|that's|this is)\s+(just\s+)?me\b|\bim (real|human|not (a )?(bot|ai))\b|\bnot (a |an )?(bot|ai)\b/i.test(text)) hard.push("claims to be human / denies being AI; never do that, just steer back to the trade");
  if (/—/.test(text)) hard.push("uses an em dash");
  if (/\b(still open|expendable|let me know if|feel free|no pressure|no worries if|per game|a game\b|ppg|points? per)\b|\d+(\.\d+)?\s*(a|per) (game|week)/i.test(text)) hard.push("salesman talk (re-pitching / stats / 'still open'); real texts don't sell, they just say the ask");
  if (/\b(hit|press|tap|just|go|pls|please|gotta|need to|needa)\s+accept\b|\baccept (it|rn|now|when|the trade|on espn)\b|\b(check|look at) (ur|your) espn\b/i.test(text)) hard.push("pesters them to accept; never do that, they'll accept when they want");
  if (p.emoji.frequency === "never" && /\p{Extended_Pictographic}/u.test(text)) hard.push("uses emoji but they never do");
  if (hard.length) return { pass: false, score: 0, feedback: hard.join("; ") };

  const res = await llm().messages.parse({
    model: modelId(),
    max_tokens: 1000,
    output_config: { format: zodOutputFormat(Verdict), effort: "low" },
    system: "You judge whether a text message could have been written by a specific person, given real examples of their texts. Be harsh about anything that reads like an assistant: full sentences with perfect punctuation, hedging, over-explaining, 'Hey!', exclamation-heavy enthusiasm, lists, or vocabulary they don't use. Separately judge clarity: casual and sloppy is fine, but the recipient must be able to tell what is being asked or said. Garbled slang salad is a fail. Anything that reads like a salesman (justifying a trade with stats, 'still open?', 'he's expendable') is an automatic 3.",
    messages: [{
      role: "user",
      content: `Real texts from them:\n${bundle.fewshots.slice(0, 25).map((f) => `- ${f.text}`).join("\n")}\n\nProfile: ${p.summary} They never: ${p.avoid.join("; ")}.\n\nCandidate:\n${text}`,
    }],
  });
  assertNotRefused(res);
  const v = res.parsed_output;
  if (!v) return { pass: true, score: 5, feedback: "" };
  if (!v.clear) return { pass: false, score: Math.min(v.score, 5), feedback: `not clear enough for the recipient to understand; say the actual point plainly. ${v.tells.join("; ")}` };
  return { pass: v.score >= 7, score: v.score, feedback: v.tells.join("; ") };
}
