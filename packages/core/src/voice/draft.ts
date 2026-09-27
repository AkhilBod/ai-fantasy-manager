import { llm, modelId, textOf, assertNotRefused } from "../brain/llm.js";
import type { MessageIntent, VoiceBundle } from "./types.js";
import { checkDraft, hardLimits, bannedIn } from "./check.js";

export interface DraftInput {
  bundle: VoiceBundle;
  intent: MessageIntent;
  /** what the message must accomplish, in plain terms */
  goal: string;
  /** who we're texting and the relationship, e.g. "Ravi, buddy from college, trash-talks a lot" */
  recipient: string;
  /** prior thread, oldest first */
  thread?: { from: "me" | "them"; text: string }[];
  /** facts the message may reference (players, records) */
  facts?: string[];
  /** player last names that must appear in the text (so an offer actually states its terms) */
  mustMention?: string[];
  /** every known player last name → whether it's allowed to appear (on my roster, theirs, or in the terms) */
  knownPlayers?: { allowed: Set<string>; all: Set<string> };
}

export function voiceSystemPrompt(bundle: VoiceBundle, intent: MessageIntent): string {
  const p = bundle.profile;
  const { maxWords, maxLines, banned } = hardLimits(bundle);
  const shots = pickFewShots(bundle, intent, 24).filter((s) => bannedIn(s.text, banned).length === 0);
  return [
    `You are texting as a specific real person. Write EXACTLY like them. This is an iMessage, not an email.`,
    `Profile: ${p.summary}`,
    `Casing: ${p.casing}. Punctuation: ${p.punctuation}. Typical length: ~${p.lengthWords.median} words. HARD LIMIT: at most ${maxWords} words and ${maxLines} line(s). If it can't fit, say less; they can ask.`,
    banned.length ? `BANNED words, never use them in any form: ${banned.join(", ")}.` : "",
    `Emoji: ${p.emoji.frequency}${p.emoji.favorites.length ? ` (${p.emoji.favorites.join(" ")})` : ""}.`,
    `Words/slang they use: ${p.lexicon.join(", ")}.`,
    `They NEVER: ${p.avoid.join("; ")}.`,
    `Openers: ${p.openers.join(" | ") || "none"}. Closers: ${p.closers.join(" | ") || "none"}.`,
    `How they talk football: ${p.footballTalk}`,
    `Negotiation style: ${p.negotiationStyle}`,
    ``,
    `Real messages they've sent (copy the vibe, not the content):`,
    ...shots.map((s) => `- ${s.text}`),
    ``,
    `Rules: output ONLY the message text, no quotes, no preamble. One message, not a list. Never mention AI, bots, or assistants, and NEVER claim to be human or deny being AI if asked; just ignore the question and talk about the trade. Never invent stats; only use provided facts. Sound like a person half-paying-attention on their phone.`,
    `If the goal names players or trade terms, the text MUST state them plainly (who for who); vague "im close" texts are useless to the other person.`,
    `Never sell. No stats, no "he's expendable", no "still open?", no justifying. A real person texts the ask and stops. If the goal is to pass, say pass in a few words with no explanation.`,
  ].filter(Boolean).join("\n");
}

export async function draftMessage(input: DraftInput, opts: { maxRewrites?: number } = {}): Promise<{ text: string; attempts: number; score: number }> {
  const system = voiceSystemPrompt(input.bundle, input.intent);
  const threadText = (input.thread ?? []).map((t) => `${t.from === "me" ? "ME" : "THEM"}: ${t.text}`).join("\n");
  const user = [
    `Recipient: ${input.recipient}`,
    `Intent: ${input.intent}`,
    `Goal: ${input.goal}`,
    input.facts?.length ? `Facts you may use:\n${input.facts.map((f) => `- ${f}`).join("\n")}` : "",
    threadText ? `Thread so far:\n${threadText}` : "",
    `Write the next text.`,
  ].filter(Boolean).join("\n\n");

  let feedback = "";
  let best = { text: "", score: -1 };
  const maxRewrites = opts.maxRewrites ?? 2;
  for (let attempt = 1; attempt <= maxRewrites + 1; attempt++) {
    const res = await llm().messages.create({
      model: modelId(),
      max_tokens: 400,
      output_config: { effort: "low" },
      system,
      messages: [{ role: "user", content: feedback ? `${user}\n\nPrevious attempt was rejected: ${feedback}` : user }],
    });
    assertNotRefused(res);
    const text = clean(textOf(res));
    const missing = (input.mustMention ?? []).filter((n) => !text.toLowerCase().includes(n.toLowerCase()));
    const invented = input.knownPlayers ? inventedPlayers(text, input.knownPlayers) : [];
    const check = invented.length
      ? { pass: false, score: 0, feedback: `mentions players not involved / not on either roster: ${invented.join(", ")}. Only name players on my roster, their roster, or in the terms.` }
      : missing.length === (input.mustMention ?? []).length && missing.length > 0
      ? { pass: false, score: 0, feedback: `must mention the players/terms: ${input.mustMention!.join(", ")}` }
      : await checkDraft(input.bundle, text);
    if (check.score > best.score) best = { text, score: check.score };
    if (check.pass) return { text, attempts: attempt, score: check.score };
    feedback = check.feedback;
  }
  // Retries exhausted: force a compressed rewrite, then hard-enforce the limits.
  const { maxWords, maxLines, banned } = hardLimits(input.bundle);
  const res = await llm().messages.create({
    model: modelId(), max_tokens: 200, output_config: { effort: "low" }, system,
    messages: [{ role: "user", content: `Rewrite this as ONE text of at most ${maxWords} words, ${maxLines} line(s) max, keeping the key ask/answer${banned.length ? `, never using: ${banned.join(", ")}` : ""}. Output only the text.\n\n${best.text}` }],
  });
  assertNotRefused(res);
  let text = clean(textOf(res)).replace(/\s*[—–]\s*/g, ", ").replace(/\b(AI|assistant|bot|language model)\b/gi, "");
  text = text.split(/\n+/).slice(0, maxLines).join("\n");
  const w = text.split(/\s+/);
  if (w.length > maxWords) text = w.slice(0, maxWords).join(" ");
  for (const b of banned) text = text.replace(new RegExp(`(^|[^a-z])${b}(?=[^a-z]|$)`, "gi"), "$1").replace(/\s{2,}/g, " ").trim();
  return { text, attempts: maxRewrites + 2, score: best.score };
}

export function pickFewShots(bundle: VoiceBundle, intent: MessageIntent, n: number) {
  const same = bundle.fewshots.filter((f) => f.intent === intent);
  const others = bundle.fewshots.filter((f) => f.intent !== intent);
  return [...same.slice(0, Math.ceil(n * 0.6)), ...others.slice(0, n)].slice(0, n);
}

function clean(t: string): string {
  return t.replace(/^["'“]+|["'”]+$/g, "").trim();
}

/** Player last names (≥4 letters, from the league-wide pool) that appear in the text but aren't allowed. */
export function inventedPlayers(text: string, known: { allowed: Set<string>; all: Set<string> }): string[] {
  const words = new Set(text.toLowerCase().replace(/[^a-z\s]/g, " ").split(/\s+/));
  const out: string[] = [];
  for (const last of known.all) if (last.length >= 4 && words.has(last) && !known.allowed.has(last)) out.push(last);
  return out;
}
