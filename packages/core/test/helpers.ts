import type { LeagueSettings, Player, RosterEntry } from "../src/espn/types.js";

let nextId = 1000;
export function player(over: Partial<Player> & { position: string }): Player {
  const posId: Record<string, number> = { QB: 1, RB: 2, WR: 3, TE: 4, K: 5, DST: 16 };
  const slots: Record<string, number[]> = { QB: [0, 20], RB: [2, 3, 23, 20], WR: [4, 3, 5, 23, 20], TE: [6, 5, 23, 20], K: [17, 20], DST: [16, 20] };
  return {
    id: over.id ?? nextId++,
    name: over.name ?? `${over.position}${nextId}`,
    position: over.position,
    positionId: posId[over.position],
    proTeam: "KC",
    eligibleSlots: slots[over.position],
    injuryStatus: "ACTIVE",
    injured: false,
    percentOwned: 50, percentStarted: 30,
    projectedWeek: 10, projectedSeason: 170, projectedRos: 0, actualWeek: 0, seasonPoints: 0, avgPoints: 0, recentPts: [],
    ...over,
  };
}

export const settings: LeagueSettings = {
  name: "test", size: 10, currentWeek: 4, finalWeek: 17,
  lineupSlots: { 0: 1, 2: 2, 4: 2, 6: 1, 23: 1, 17: 1, 16: 1, 20: 6 },
  usesFaab: true, faabBudget: 100, waiverProcessDays: [3],
};

export function roster(players: Player[], slotOf: (p: Player) => number = () => 20): RosterEntry[] {
  return players.map((p) => ({ player: p, lineupSlotId: slotOf(p) }));
}
