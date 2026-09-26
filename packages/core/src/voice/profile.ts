import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { llm, modelId, assertNotRefused } from "../brain/llm.js";
import { FewShotSchema, VoiceProfileSchema, type ExportedMessage, type VoiceBundle } from "./types.js";

const BuildSchema = z.object({ profile: VoiceProfileSchema, fewshots: z.array(FewShotSchema) });

/**
 * Turn a pile of the user's own texts into a style profile + few-shot bank.
 * League/leaguemate chats are weighted first; "other" fills in general voice.
 */
export async function buildVoiceBundle(messages: ExportedMessage[], opts: { maxMessages?: number } = {}): Promise<VoiceBundle> {
  const max = opts.maxMessages ?? 2500;
  const ranked = [...messages]
    .filter((m) => m.text.trim().length > 0 && !/^https?:\/\/\S+$/.test(m.text.trim()))
    .sort((a, b) => weight(b) - weight(a) || b.at.localeCompare(a.at))
    .slice(0, max);

  const corpus = ranked.map((m) => `[${m.chat}] ${m.text.replace(/\n/g, " ")}`).join("\n");

  const res = await llm().messages.parse({
    model: modelId(),
    max_tokens: 16000,
    output_config: { format: zodOutputFormat(BuildSchema), effort: "high" },
    system: [
      "You are building a writing-style profile of one person from their own iMessages so an assistant can text on their behalf and be indistinguishable from them.",
      "Be concrete and verbatim: quote the exact slang, abbreviations, punctuation habits, and emoji they use. Note what they NEVER do.",
      "For fewshots, pick 40-60 REAL messages from the corpus (copy exactly, do not edit) that best represent each intent. Prefer [league] and [leaguemate] messages. Cover: propose (offering something / asking for something), counter, accept, decline, nudge (following up), banter, reply (short reactions), summary (explaining something).",
      "Never include names of third parties, phone numbers, addresses, or anything sensitive in fewshots; skip such messages.",
    ].join("\n"),
    messages: [{ role: "user", content: `Corpus (${ranked.length} messages, newest first within each group):\n\n${corpus}` }],
  });
  assertNotRefused(res);
  const parsed = res.parsed_output;
  if (!parsed) throw new Error("voice profile parse failed");
  return { ...parsed, builtAt: new Date().toISOString(), sourceMessageCount: ranked.length };
}

function weight(m: ExportedMessage): number {
  return m.chat === "league" ? 3 : m.chat === "leaguemate" ? 2 : 1;
}
