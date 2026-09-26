import type { LeagueSettings, Player } from "../espn/types.js";
import { UNPLAYABLE } from "../espn/constants.js";

/**
 * Deterministic rest-of-season value. The LLM reasons on top of this; the
 * guardrails use it directly so a persuasive counterparty can't talk the agent
 * into a lopsided trade.
 *
 *   value = replacement-adjusted ROS projection × availability × recency blend
 */

export interface ValueInputs {
  /** FantasyPros-style rest-of-season consensus rank per player id, lower = better */
  rosRank?: Map<number, number>;
  currentWeek: number;
  finalWeek: number;
}

const STARTER_SLOTS_PER_POS: Record<string, number> = { QB: 1, RB: 2.5, WR: 2.5, TE: 1, K: 1, DST: 1 };

export function replacementLevel(pool: Player[], settings: LeagueSettings, position: string, weeksLeft = 17): number {
  const n = Math.round((STARTER_SLOTS_PER_POS[position] ?? 1) * settings.size) + 2;
  const sorted = pool.filter((p) => p.position === position).map((p) => rosPerWeek(p, weeksLeft)).sort((a, b) => b - a);
  return sorted[Math.min(n, sorted.length - 1)] ?? 0;
}

export function rosProjection(p: Player): number {
  // ESPN season projection is cumulative; fall back to avg × 17 when missing.
  if (p.projectedSeason > 0) return p.projectedSeason;
  if (p.avgPoints > 0) return p.avgPoints * 17;
  return p.projectedWeek * 17;
}

/** Projected points per remaining week: ESPN's rest-of-season row when present, else season projection / 17. */
export function rosPerWeek(p: Player, weeksLeft: number): number {
  if (p.projectedRos > 0 && weeksLeft > 0) return p.projectedRos / weeksLeft;
  return rosProjection(p) / 17;
}

export function playerValue(p: Player, pool: Player[], settings: LeagueSettings, inputs: ValueInputs, opts: { curve?: boolean } = {}): number {
  const weeksLeft = Math.max(1, inputs.finalWeek - inputs.currentWeek + 1);
  const perWeekRos = rosPerWeek(p, weeksLeft);
  const perWeekRecent = p.avgPoints > 0 ? p.avgPoints : perWeekRos;
  const last3 = p.recentPts.length ? p.recentPts.reduce((a, b) => a + b, 0) / p.recentPts.length : perWeekRecent;
  // Projection anchors; season average and last-3 form pull it toward what's actually happening.
  const blended = inputs.currentWeek <= 2 ? perWeekRos : 0.55 * perWeekRos + 0.25 * perWeekRecent + 0.2 * last3;
  const repl = replacementLevel(pool, settings, p.position, weeksLeft);
  let v = Math.max(0, blended - repl) * weeksLeft;

  if (UNPLAYABLE.has(p.injuryStatus)) v *= p.injuryStatus === "OUT" ? 0.7 : 0.4;
  else if (p.injuryStatus === "DOUBTFUL") v *= 0.85;

  const rank = inputs.rosRank?.get(p.id);
  if (rank != null) {
    // Consensus rank nudges: top-24 overall get a premium, deep ranks a haircut.
    if (rank <= 12) v *= 1.15;
    else if (rank <= 24) v *= 1.08;
    else if (rank > 150) v *= 0.9;
  }
  // Star curve (my side only): fantasy is won by lineup ceilings, not roster sums. One 100 beats two 50s.
  if (opts.curve !== false) v = Math.pow(v, 1.25);
  return Math.round(v * 10) / 10;
}

export function valueMap(players: Player[], pool: Player[], settings: LeagueSettings, inputs: ValueInputs, opts: { curve?: boolean } = {}): Map<number, number> {
  const m = new Map<number, number>();
  for (const p of players) m.set(p.id, playerValue(p, pool, settings, inputs, opts));
  return m;
}

export function sumValue(ids: number[], values: Map<number, number>): number {
  return ids.reduce((s, id) => s + (values.get(id) ?? 0), 0);
}
