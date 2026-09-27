import type { LeagueConfig, Rules } from "../config.js";
import type { Player } from "../espn/types.js";
import { UNPLAYABLE } from "../espn/constants.js";

export interface TradeCheckInput {
  give: number[];
  get: number[];
  values: Map<number, number>;
  rosRank?: Map<number, number>;
  players: Map<number, Player>;
  /** projected weekly points of my optimal lineup before → after the trade; must not go down */
  lineupDelta?: number;
  /** my players already in a pending ESPN trade */
  committed?: Set<number>;
  /** "initiate" (my idea, higher bar) or "respond" (their offer / my counter to it: just don't lose) */
  mode?: "initiate" | "respond";
}

export interface CheckResult { ok: boolean; reasons: string[] }

export function checkTrade(input: TradeCheckInput, cfg: LeagueConfig, rules: Rules): CheckResult {
  const reasons: string[] = [];
  const giveV = input.give.reduce((s, id) => s + (input.values.get(id) ?? 0), 0);
  const getV = input.get.reduce((s, id) => s + (input.values.get(id) ?? 0), 0);
  const gain = giveV === 0 ? (getV > 0 ? 1 : 0) : (getV - giveV) / giveV;

  for (const id of input.give) {
    if (cfg.untouchables.includes(id)) reasons.push(`${name(input, id)} is untouchable`);
    if (input.committed?.has(id)) reasons.push(`${name(input, id)} is already in a pending trade`);
    const rank = input.rosRank?.get(id);
    if (rank != null && rank <= rules.protectTopNRanked && gain < rules.protectedTradeGainPct) {
      reasons.push(`${name(input, id)} is top-${rules.protectTopNRanked} ranked; need ≥${pct(rules.protectedTradeGainPct)} gain, got ${pct(gain)}`);
    }
  }
  const minGain = input.mode === "respond" ? rules.minRespondGainPct : rules.minTradeGainPct;
  const minLineup = input.mode === "respond" ? rules.minRespondLineupDelta : rules.minLineupDelta;
  if (gain < minGain) reasons.push(`value gain ${pct(gain)} below floor ${pct(minGain)} (give ${giveV.toFixed(1)}, get ${getV.toFixed(1)})`);
  if (input.lineupDelta != null && input.lineupDelta < minLineup) reasons.push(`starting lineup would change by ${input.lineupDelta.toFixed(1)} pts/wk (need ≥ ${minLineup})`);
  if (input.give.length === 0 || input.get.length === 0) reasons.push("trade must move players both ways");
  return { ok: reasons.length === 0, reasons };
}

/** Incoming offers: refuse if anything coming to me can't play (OUT / IR / suspended). Discounted value isn't enough; a friend dumping an injured guy is the classic fantasy scam. */
export function checkReceivedHealthy(get: number[], players: Map<number, Player>): CheckResult {
  const bad = get.map((id) => players.get(id)).filter((p): p is Player => !!p && UNPLAYABLE.has(p.injuryStatus));
  return bad.length ? { ok: false, reasons: bad.map((p) => `${p.name} is ${p.injuryStatus}; not accepting injured players`) } : { ok: true, reasons: [] };
}

export function checkDrop(playerId: number, dropsThisWeek: number, cfg: LeagueConfig, rules: Rules, players: Map<number, Player>): CheckResult {
  const reasons: string[] = [];
  if (cfg.untouchables.includes(playerId)) reasons.push(`${players.get(playerId)?.name ?? playerId} is untouchable`);
  if (dropsThisWeek >= rules.maxDropsPerWeek) reasons.push(`already dropped ${dropsThisWeek} this week (max ${rules.maxDropsPerWeek})`);
  return { ok: reasons.length === 0, reasons };
}

export function checkBid(bid: number, faabRemaining: number, faabBudget: number, spentThisWeek: number, rules: Rules): CheckResult {
  const reasons: string[] = [];
  const cap = Math.floor(faabBudget * rules.maxFaabPctPerWeek);
  if (bid < 0) reasons.push("negative bid");
  if (bid > faabRemaining) reasons.push(`bid ${bid} exceeds remaining FAAB ${faabRemaining}`);
  if (spentThisWeek + bid > cap) reasons.push(`weekly FAAB cap ${cap} would be exceeded (${spentThisWeek} already committed)`);
  return { ok: reasons.length === 0, reasons };
}

export function inQuietHours(now: Date, tz: string, rules: Rules): boolean {
  const hour = Number(new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false, timeZone: tz }).format(now));
  const { start, end } = rules.quietHours;
  return start > end ? hour >= start || hour < end : hour >= start && hour < end;
}

const name = (i: TradeCheckInput, id: number) => i.players.get(id)?.name ?? String(id);
const pct = (n: number) => `${(n * 100).toFixed(0)}%`;
