import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(here, "../../..");

const TeamSchema = z.object({
  name: z.string(),
  phone: z.string().optional(),
  self: z.boolean().optional(),
});

export const LeagueConfigSchema = z.object({
  leagueId: z.number(),
  season: z.number(),
  myTeamId: z.number(),
  timezone: z.string().default("America/New_York"),
  teams: z.record(z.string(), TeamSchema),
  leagueGroupChatName: z.string().optional(),
  untouchables: z.array(z.number()).default([]),
  trustedFirst: z.array(z.string()).default([]),
});
export type LeagueConfig = z.infer<typeof LeagueConfigSchema>;

export const RulesSchema = z.object({
  maxFaabPctPerWeek: z.number(),
  maxDropsPerWeek: z.number(),
  maxOpenTrades: z.number(),
  /** value gain required for deals I initiate */
  minTradeGainPct: z.number(),
  /** value gain required when accepting/countering THEIR offer: just don't lose */
  minRespondGainPct: z.number().default(0.02),
  minRespondLineupDelta: z.number().default(0),
  protectTopNRanked: z.number(),
  protectedTradeGainPct: z.number(),
  maxTextsPerPersonPerDay: z.number(),
  /** replies to their messages (the nag guard handles spam; this is just a sanity ceiling) */
  maxRepliesPerPersonPerDay: z.number().default(30),
  quietHours: z.object({ start: z.number(), end: z.number() }),
  negotiationExpiryDays: z.number(),
  maxCounterRounds: z.number(),
  autoAcceptIncoming: z.boolean().default(false),
  acceptIncomingMinGainPct: z.number().default(0.2),
  maxNewOffersPerWeek: z.number().default(2),
  teamCooldownDays: z.number().default(10),
  /** never appear in an outgoing text, whatever the voice profile says */
  bannedWords: z.array(z.string()).default([]),
  maxMessageWords: z.number().default(15),
  maxMessageLines: z.number().default(2),
  /** a trade must raise my optimal weekly lineup projection by at least this many points */
  minLineupDelta: z.number().default(1),
  /** silent ESPN proposals (no text): per day, only when none of mine are pending */
  maxSilentProposalsPerDay: z.number().default(2),
  silentProposalCooldownDays: z.number().default(4),
  /** no reply to an offer → leave them alone this long; explicit no → this long */
  unresponsiveCooldownDays: z.number().default(21),
  declinedCooldownDays: z.number().default(14),
});
export type Rules = z.infer<typeof RulesSchema>;

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function loadLeagueConfig(): LeagueConfig {
  const fromEnv = process.env.LEAGUE_CONFIG_JSON;
  if (fromEnv) return LeagueConfigSchema.parse(JSON.parse(fromEnv));
  const path = process.env.LEAGUE_CONFIG_PATH ?? resolve(repoRoot, "config/league.json");
  if (!existsSync(path)) {
    throw new Error(`Missing ${path}. Copy config/league.example.json to config/league.json and fill it in.`);
  }
  return LeagueConfigSchema.parse(readJson(path));
}

export function loadRules(): Rules {
  const fromEnv = process.env.RULES_JSON;
  if (fromEnv) return RulesSchema.parse(JSON.parse(fromEnv));
  const own = resolve(repoRoot, "config/rules.json");
  return RulesSchema.parse(readJson(existsSync(own) ? own : resolve(repoRoot, "config/rules.example.json")));
}

export const env = {
  get dryRun(): boolean {
    return process.env.DRY_RUN !== "0" && process.env.DRY_RUN !== "false";
  },
  get store(): "local" | "dynamo" {
    return process.env.STORE === "dynamo" ? "dynamo" : "local";
  },
  get tablePrefix(): string {
    return process.env.TABLE_PREFIX ?? "ffm";
  },
  get region(): string {
    return process.env.AWS_REGION ?? "us-east-1";
  },
};
