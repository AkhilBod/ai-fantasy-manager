import { z } from "zod";

export const VoiceProfileSchema = z.object({
  summary: z.string().describe("2-3 sentences on how this person texts"),
  casing: z.enum(["lowercase", "sentence", "mixed"]),
  punctuation: z.string().describe("e.g. 'rarely ends with periods, uses ?? and !! for emphasis'"),
  lengthWords: z.object({ median: z.number(), p90: z.number() }),
  emoji: z.object({ frequency: z.enum(["never", "rare", "sometimes", "often"]), favorites: z.array(z.string()) }),
  lexicon: z.array(z.string()).describe("slang, abbreviations, filler words they actually use, verbatim"),
  avoid: z.array(z.string()).describe("things they never do (e.g. 'Hey!', formal greetings, semicolons)"),
  openers: z.array(z.string()),
  closers: z.array(z.string()),
  footballTalk: z.string().describe("how they talk about players/trades specifically"),
  negotiationStyle: z.string().describe("pushy, chill, jokey, blunt..."),
});
export type VoiceProfile = z.infer<typeof VoiceProfileSchema>;

export type MessageIntent = "propose" | "counter" | "accept" | "decline" | "nudge" | "banter" | "reply" | "summary";

export const FewShotSchema = z.object({ intent: z.enum(["propose", "counter", "accept", "decline", "nudge", "banter", "reply", "summary"]), text: z.string() });
export type FewShot = z.infer<typeof FewShotSchema>;

export const VoiceBundleSchema = z.object({
  profile: VoiceProfileSchema,
  fewshots: z.array(FewShotSchema),
  builtAt: z.string(),
  sourceMessageCount: z.number(),
});
export type VoiceBundle = z.infer<typeof VoiceBundleSchema>;

/** Anonymized export produced on the Mac. Never contains phone numbers. */
export interface ExportedMessage {
  text: string;
  chat: "league" | "leaguemate" | "other";
  at: string;
}
