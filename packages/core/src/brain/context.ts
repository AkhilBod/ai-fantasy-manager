import { EspnClient, loadEspnCredsFromEnv } from "../espn/client.js";
import type { LeagueSnapshot, Player, Team } from "../espn/types.js";
import { loadLeagueConfig, loadRules, type LeagueConfig, type Rules } from "../config.js";
import { fetchRosEcr, matchEcrToEspn } from "../data/fantasypros.js";
import { sleeperByEspnId, type SleeperPlayer } from "../data/sleeper.js";
import { valueMap } from "../valuation/player-value.js";
import { store } from "../store/index.js";
import { optimizeLineup } from "./lineup.js";
import { rosPerWeek } from "../valuation/player-value.js";
import type { Store } from "../store/types.js";

/** Everything a brain module needs, loaded once per run. */
export interface Ctx {
  cfg: LeagueConfig;
  rules: Rules;
  client: EspnClient;
  snap: LeagueSnapshot;
  me: Team;
  week: number;
  /** every rostered player + top free agents */
  pool: Player[];
  players: Map<number, Player>;
  values: Map<number, number>;
  /** plain (uncurved) values: what a neutral observer would call fair */
  linearValues: Map<number, number>;
  rosRank: Map<number, number>;
  sleeper: Map<number, SleeperPlayer>;
  store: Store;
  /** my players already committed in a pending ESPN trade; never offer them again */
  committed: Set<number>;
  /** my players who don't make my optimal lineup: cheaper to give away */
  benchIds: Set<number>;
}

export async function loadCtx(opts: { freeAgentLimit?: number; week?: number } = {}): Promise<Ctx> {
  const cfg = loadLeagueConfig();
  const rules = loadRules();
  const client = new EspnClient({ leagueId: cfg.leagueId, season: cfg.season, creds: loadEspnCredsFromEnv() });
  const snap = await client.snapshot(opts.week);
  const week = opts.week ?? snap.settings.currentWeek;
  const me = snap.teams.find((t) => t.id === cfg.myTeamId);
  if (!me) throw new Error(`team ${cfg.myTeamId} not found`);

  const [fas, ecr, sleeper, pending] = await Promise.all([
    client.freeAgents(week, { limit: opts.freeAgentLimit ?? 200 }).catch(() => []),
    fetchRosEcr(),
    sleeperByEspnId().catch(() => new Map<number, SleeperPlayer>()),
    client.pendingTrades().catch(() => []),
  ]);
  const committed = new Set<number>();
  // Committed = my players in a trade the other side already accepted (ESPN would fail a second deal for them).
  for (const t of pending) for (const i of t.items) if (i.fromTeamId === cfg.myTeamId && t.type === "TRADE_ACCEPT") committed.add(i.playerId);
  const rostered = snap.teams.flatMap((t) => t.roster.map((e) => e.player));
  const pool = [...rostered, ...fas];
  const players = new Map(pool.map((p) => [p.id, p]));
  const rosRank = matchEcrToEspn(ecr, pool);
  const values = valueMap(pool, pool, snap.settings, { rosRank, currentWeek: week, finalWeek: snap.settings.finalWeek });
  const linearValues = valueMap(pool, pool, snap.settings, { rosRank, currentWeek: week, finalWeek: snap.settings.finalWeek }, { curve: false });

  // Fold Sleeper injury status in when ESPN is stale.
  for (const p of pool) {
    const s = sleeper.get(p.id);
    if (s?.injury_status && p.injuryStatus === "ACTIVE") {
      const map: Record<string, Player["injuryStatus"]> = { Questionable: "QUESTIONABLE", Doubtful: "DOUBTFUL", Out: "OUT", IR: "INJURY_RESERVE", Sus: "SUSPENSION" };
      p.injuryStatus = map[s.injury_status] ?? p.injuryStatus;
    }
  }

  const starters = new Set(optimizeLineup(me.roster, snap.settings).starters.map((x) => x.player.id));
  const benchIds = new Set(me.roster.map((e) => e.player.id).filter((id) => !starters.has(id)));
  return { cfg, rules, client, snap, me, week, pool, players, values, linearValues, rosRank, sleeper, store: store(), committed, benchIds };
}

export function playerLine(ctx: Ctx, p: Player): string {
  const s = ctx.sleeper.get(p.id);
  const inj = p.injuryStatus !== "ACTIVE" ? ` [${p.injuryStatus}${s?.injury_body_part ? ": " + s.injury_body_part : ""}]` : "";
  const rank = ctx.rosRank.get(p.id);
  const form = p.recentPts.length ? ` L3=${p.recentPts.join("/")}` : "";
  return `${p.name} (${p.position}, ${p.proTeam}) id=${p.id} value=${ctx.values.get(p.id) ?? 0} wk=${p.projectedWeek.toFixed(1)} avg=${p.avgPoints.toFixed(1)}${form} own=${p.percentOwned.toFixed(0)}%${rank ? ` ecr=${rank}` : ""}${inj}`;
}

export function teamBlock(ctx: Ctx, t: Team): string {
  const lines = [...t.roster].sort((a, b) => (ctx.values.get(b.player.id) ?? 0) - (ctx.values.get(a.player.id) ?? 0)).map((e) => "  " + playerLine(ctx, e.player));
  return `${t.name} (team ${t.id}, ${t.wins}-${t.losses}, PF ${t.pointsFor.toFixed(0)}):\n${lines.join("\n")}`;
}

export function positionalNeeds(ctx: Ctx, t: Team): string {
  const byPos = new Map<string, number[]>();
  for (const e of t.roster) {
    const arr = byPos.get(e.player.position) ?? [];
    arr.push(ctx.values.get(e.player.id) ?? 0);
    byPos.set(e.player.position, arr);
  }
  return [...byPos].map(([pos, vals]) => `${pos}: ${vals.sort((a, b) => b - a).map((v) => v.toFixed(0)).join("/")}`).join("  ");
}

/** Roster spots that count toward ESPN's cap (IR excluded). */
export function rosterCap(ctx: Ctx): number {
  return Object.entries(ctx.snap.settings.lineupSlots).filter(([slot]) => Number(slot) !== 21).reduce((a, [, n]) => a + n, 0);
}

/** Drops needed to receive `get` while giving `give`: lowest-value non-starter, never untouchable, never a traded piece. */
export function pickDrops(ctx: Ctx, give: number[], get: number[]): number[] {
  const active = ctx.me.roster.filter((e) => e.lineupSlotId !== 21);
  const need = active.length - give.length + get.length - rosterCap(ctx);
  if (need <= 0) return [];
  const candidates = active
    .map((e) => e.player)
    .filter((p) => !give.includes(p.id) && !ctx.cfg.untouchables.includes(p.id))
    .sort((a, b) => (ctx.values.get(a.id) ?? 0) - (ctx.values.get(b.id) ?? 0) || a.projectedWeek - b.projectedWeek);
  return candidates.slice(0, need).map((p) => p.id);
}

/** Change in my optimal lineup's projected points per week (rest-of-season basis) if I give `give` and get `get`. */
export function lineupDelta(ctx: Ctx, give: number[], get: number[]): number {
  const weeksLeft = Math.max(1, ctx.snap.settings.finalWeek - ctx.week + 1);
  const score = (p: Player) => (p.avgPoints > 0 && ctx.week > 3 ? 0.5 * p.avgPoints + 0.5 * rosPerWeek(p, weeksLeft) : rosPerWeek(p, weeksLeft)) * (UNPLAYABLE_SET.has(p.injuryStatus) ? 0.5 : 1);
  const before = optimizeLineup(ctx.me.roster, ctx.snap.settings, score).projected;
  const after = optimizeLineup([
    ...ctx.me.roster.filter((e) => !give.includes(e.player.id)),
    ...get.map((id) => ctx.players.get(id)).filter((p): p is Player => !!p).map((player) => ({ player, lineupSlotId: 20 })),
  ], ctx.snap.settings, score).projected;
  return Math.round((after - before) * 10) / 10;
}
const UNPLAYABLE_SET = new Set(["OUT", "INJURY_RESERVE", "SUSPENSION"]);
