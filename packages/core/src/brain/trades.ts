import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { llm, modelId, assertNotRefused } from "./llm.js";
import { positionalNeeds, teamBlock, type Ctx } from "./context.js";
import { lineupDelta } from "./context.js";
import { checkTrade, checkFairness } from "../guardrails/rules.js";
import { sumValue } from "../valuation/player-value.js";
import type { Team } from "../espn/types.js";
import { UNPLAYABLE } from "../espn/constants.js";
import { newsBrief } from "../data/news.js";

export interface TradeIdea {
  otherTeamId: number;
  give: number[];
  get: number[];
  myGainPct: number;
  theirGainPct: number;
  rationale: string;
  pitch: string;
}

const Ideas = z.object({
  whyEmptyOrNotes: z.string().describe("one sentence: why these picks, or why nothing is worth sending"),
  ideas: z.array(z.object({
    candidateIndex: z.number().describe("index (#n) of the mechanically generated candidate to pitch"),
    rationale: z.string().describe("why this helps me, 1-2 sentences"),
    pitch: z.string().describe("why THEY should want it, framed from their perspective, honest"),
  })),
});

/**
 * Generate candidate trades mechanically (value + positional fit), then let
 * Claude pick the few worth pitching. Guardrails filter before anything is
 * returned so the LLM can't propose a lopsided-against-us deal.
 */
export async function scanTrades(ctx: Ctx, opts: { maxIdeas?: number; excludeTeamIds?: number[] } = {}): Promise<TradeIdea[]> {
  // trustedFirst (league.json) restricts who we pitch to until it's cleared.
  const trusted = ctx.cfg.trustedFirst.map(Number);
  const others = ctx.snap.teams.filter((t) => t.id !== ctx.me.id && !(opts.excludeTeamIds ?? []).includes(t.id) && (trusted.length === 0 || trusted.includes(t.id)));
  const candidates = generateCandidates(ctx, others).slice(0, 60);
  console.log(`[trades] ${candidates.length} candidates vs ${others.length} teams`);
  if (candidates.length === 0) return [];
  const withDelta = candidates.map((c) => ({ ...c, lineup: lineupDelta(ctx, c.give, c.get) })).sort((a, b) => b.lineup - a.lineup);
  for (const c of withDelta.slice(0, 5)) console.log(`[trades]   top: team ${c.otherTeamId} give ${c.give.map((id) => ctx.players.get(id)?.name).join("+")} get ${c.get.map((id) => ctx.players.get(id)?.name).join("+")} lineup ${c.lineup >= 0 ? "+" : ""}${c.lineup} my ${(c.myGainPct * 100).toFixed(0)}% their ${(c.theirGainPct * 100).toFixed(0)}%`);

  const news = await newsBrief(ctx, candidates.slice(0, 12).flatMap((c) => [...c.give, ...c.get]));
  const candText = candidates.map((c, i) =>
    `#${i} team ${c.otherTeamId}: give [${c.give.map((id) => ctx.players.get(id)?.name).join(", ")}] get [${c.get.map((id) => ctx.players.get(id)?.name).join(", ")}] myGain ${(c.myGainPct * 100).toFixed(0)}% theirGain ${(c.theirGainPct * 100).toFixed(0)}% myLineup ${lineupDelta(ctx, c.give, c.get) >= 0 ? "+" : ""}${lineupDelta(ctx, c.give, c.get)} pts/wk`).join("\n");

  const res = await llm().messages.parse({
    model: modelId(),
    max_tokens: 8000,
    output_config: { format: zodOutputFormat(Ideas), effort: "high" },
    system: "You are a sharp but fair fantasy football manager. Use everything a good manager uses: rest-of-season projections, season average, last-3-game form (L3), injuries and news, schedule/bye context, and the other manager's roster needs. The number that matters is myLineup (weekly starting-lineup gain); raw value sums lie. Prefer consolidating depth into a star (2-for-1 where I get the best player) over 1-for-2/3 deals that add bench bodies. Pick trades that are realistic (the other side has a genuine reason to say yes and would be fine with it a month later), improve my starting lineup rest-of-season, and don't gut depth. Prefer consolidating 2-for-1 when I have surplus. Never propose the same player to two teams. Never exploit a friend who's not paying attention; win on roster fit, not on them missing an injury. Never include OUT / IR / suspended players as pieces of an offer; nobody bites on damaged goods and it makes the offer look like a dump.",
    messages: [{
      role: "user",
      content: [
        `Week ${ctx.week}. My team:\n${teamBlock(ctx, ctx.me)}\nMy positional values: ${positionalNeeds(ctx, ctx.me)}`,
        ``,
        ...others.map((t) => `${teamBlock(ctx, t)}\nTheir positional values: ${positionalNeeds(ctx, t)}\n`),
        news ? `Latest news on players in the top candidates:\n${news}` : "",
        `Mechanically generated candidates (value-based):\n${candText}`,
        ``,
        `Pick up to ${opts.maxIdeas ?? ctx.rules.maxOpenTrades} candidates (by #index) worth proposing, at most one per team, favoring the biggest myLineup gain that the other side could plausibly say yes to. Only choose from the list. Return an empty list ONLY if no candidate has myLineup ≥ ${ctx.rules.minLineupDelta}.`,
      ].filter(Boolean).join("\n"),
    }],
  });
  assertNotRefused(res);
  const picked = res.parsed_output?.ideas ?? [];
  console.log(`[trades] model: ${res.parsed_output?.whyEmptyOrNotes ?? "(no output)"}`);
  const ideas = picked.flatMap((p) => (candidates[p.candidateIndex] ? [{ ...candidates[p.candidateIndex], rationale: p.rationale, pitch: p.pitch }] : []));

  const out: TradeIdea[] = [];
  const used = new Set<number>();
  for (const idea of ideas) {
    const check = checkTrade({ give: idea.give, get: idea.get, values: ctx.values, rosRank: ctx.rosRank, players: ctx.players, committed: ctx.committed, lineupDelta: lineupDelta(ctx, idea.give, idea.get) }, ctx.cfg, ctx.rules);
    if (!check.ok) { console.log(`[trades] dropped idea vs team ${idea.otherTeamId}: ${check.reasons.join("; ")}`); continue; }
    const fair = checkFairness({ give: idea.give, get: idea.get, values: ctx.linearValues, players: ctx.players }, ctx.rules);
    if (!fair.ok) { console.log(`[trades] dropped idea vs team ${idea.otherTeamId}: ${fair.reasons.join("; ")}`); continue; }
    if (idea.give.some((id) => used.has(id))) continue;
    const other = others.find((t) => t.id === idea.otherTeamId);
    if (!other || !idea.get.every((id) => other.roster.some((e) => e.player.id === id)) || !idea.give.every((id) => ctx.me.roster.some((e) => e.player.id === id))) continue;
    idea.give.forEach((id) => used.add(id));
    out.push({ ...idea, myGainPct: gain(ctx, idea.give, idea.get), theirGainPct: gain(ctx, idea.get, idea.give) });
  }
  return out;
}

export function gain(ctx: Ctx, give: number[], get: number[]): number {
  const g = sumValue(give, ctx.values);
  const r = sumValue(get, ctx.values);
  return g === 0 ? (r > 0 ? 1 : 0) : (r - g) / g;
}

function generateCandidates(ctx: Ctx, others: Team[]) {
  const mine = ctx.me.roster.map((e) => e.player).filter((p) => !ctx.cfg.untouchables.includes(p.id) && !UNPLAYABLE.has(p.injuryStatus) && !ctx.committed.has(p.id));
  const out: { otherTeamId: number; give: number[]; get: number[]; myGainPct: number; theirGainPct: number }[] = [];
  const v = (id: number) => ctx.values.get(id) ?? 0;
  const lv = (id: number) => ctx.linearValues.get(id) ?? 0;
  for (const t of others) {
    const theirs = t.roster.map((e) => e.player);
    for (const want of theirs) {
      if (v(want.id) < 5) continue;
      // 1-for-1
      for (const g of mine) {
        const my = (v(want.id) - v(g.id)) / Math.max(1, v(g.id));
        const their = (lv(g.id) - lv(want.id)) / Math.max(1, lv(want.id));
        if (my >= ctx.rules.minTradeGainPct && their >= -ctx.rules.maxTheirLossPct) out.push({ otherTeamId: t.id, give: [g.id], get: [want.id], myGainPct: my, theirGainPct: their });
      }
      // 2-for-1 consolidation
      for (let i = 0; i < mine.length; i++) for (let j = i + 1; j < mine.length; j++) {
        const give = [mine[i].id, mine[j].id];
        const gv = v(give[0]) + v(give[1]);
        const my = (v(want.id) - gv) / Math.max(1, gv);
        const their = (lv(give[0]) + lv(give[1]) - lv(want.id)) / Math.max(1, lv(want.id));
        if (my >= ctx.rules.minTradeGainPct && their >= -ctx.rules.maxTheirLossPct && v(want.id) > Math.max(v(give[0]), v(give[1])) * 1.3) out.push({ otherTeamId: t.id, give, get: [want.id], myGainPct: my, theirGainPct: their });
      }
    }
  }
  // Favor deals with balanced gains: both sides > 0 first.
  return out.sort((a, b) => (Math.min(b.myGainPct, b.theirGainPct + 0.1) - Math.min(a.myGainPct, a.theirGainPct + 0.1)));
}
