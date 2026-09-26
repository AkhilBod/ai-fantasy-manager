import { BENCH_SLOT, IR_SLOT, STARTING_SLOTS, UNPLAYABLE, SLOT_BY_ID } from "../espn/constants.js";
import type { LeagueSettings, Player, RosterEntry } from "../espn/types.js";
import type { LineupChange } from "../espn/transactions.js";

export interface LineupResult {
  starters: { slotId: number; player: Player }[];
  bench: Player[];
  changes: LineupChange[];
  projected: number;
  /** starters whose status is QUESTIONABLE/DOUBTFUL and who have a close bench alternative */
  flags: { starter: Player; alternative: Player; slotId: number }[];
}

export function playable(p: Player): boolean {
  return !UNPLAYABLE.has(p.injuryStatus) && p.proTeam !== "FA";
}

/**
 * Greedy-by-scarcity assignment: fill the slots with the fewest eligible
 * candidates first so a TE isn't burned in FLEX before the TE slot is filled.
 */
export function optimizeLineup(roster: RosterEntry[], settings: LeagueSettings, score: (p: Player) => number = (p) => p.projectedWeek): LineupResult {
  const irLocked = roster.filter((e) => e.lineupSlotId === IR_SLOT);
  const available = roster.filter((e) => e.lineupSlotId !== IR_SLOT).map((e) => e.player);
  const slots: number[] = [];
  for (const [slotStr, count] of Object.entries(settings.lineupSlots)) {
    const slotId = Number(slotStr);
    if (!STARTING_SLOTS.has(slotId)) continue;
    for (let i = 0; i < count; i++) slots.push(slotId);
  }
  const eligibleFor = (slotId: number) => available.filter((p) => p.eligibleSlots.includes(slotId) && playable(p));
  slots.sort((a, b) => eligibleFor(a).length - eligibleFor(b).length);

  const used = new Set<number>();
  const starters: { slotId: number; player: Player }[] = [];
  for (const slotId of slots) {
    const best = eligibleFor(slotId).filter((p) => !used.has(p.id)).sort((a, b) => score(b) - score(a))[0];
    if (best) { used.add(best.id); starters.push({ slotId, player: best }); }
  }
  // Second pass: swap-improve (fixes greedy misorders when flex-eligible studs got stuck on bench).
  let improved = true;
  while (improved) {
    improved = false;
    for (const s of starters) {
      for (const cand of available) {
        if (used.has(cand.id) || !playable(cand) || !cand.eligibleSlots.includes(s.slotId)) continue;
        if (score(cand) > score(s.player) + 1e-9) {
          used.delete(s.player.id); used.add(cand.id); s.player = cand; improved = true;
        }
      }
    }
  }

  const bench = available.filter((p) => !used.has(p.id));
  const changes: LineupChange[] = [];
  const current = new Map(roster.map((e) => [e.player.id, e.lineupSlotId]));
  for (const s of starters) if (current.get(s.player.id) !== s.slotId) changes.push({ playerId: s.player.id, toSlotId: s.slotId });
  for (const p of bench) if (current.get(p.id) !== BENCH_SLOT) changes.push({ playerId: p.id, toSlotId: BENCH_SLOT });
  void irLocked;

  const flags: LineupResult["flags"] = [];
  for (const s of starters) {
    if (s.player.injuryStatus !== "QUESTIONABLE" && s.player.injuryStatus !== "DOUBTFUL") continue;
    const alt = bench.filter((p) => p.eligibleSlots.includes(s.slotId) && p.injuryStatus === "ACTIVE" && playable(p)).sort((a, b) => score(b) - score(a))[0];
    if (alt && score(alt) >= score(s.player) * 0.8) flags.push({ starter: s.player, alternative: alt, slotId: s.slotId });
  }

  return { starters, bench, changes, projected: starters.reduce((t, s) => t + score(s.player), 0), flags };
}

export function describeLineup(r: LineupResult): string {
  const lines = r.starters.map((s) => `${(SLOT_BY_ID[s.slotId] ?? s.slotId).toString().padEnd(5)} ${s.player.name} (${s.player.projectedWeek.toFixed(1)}${s.player.injuryStatus !== "ACTIVE" ? ", " + s.player.injuryStatus : ""})`);
  lines.push(`proj ${r.projected.toFixed(1)} | ${r.changes.length} change(s)`);
  return lines.join("\n");
}
