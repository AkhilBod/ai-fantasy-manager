import type { InjuryStatus } from "./constants.js";

export interface Player {
  id: number;
  name: string;
  position: string;
  positionId: number;
  proTeam: string;
  eligibleSlots: number[];
  injuryStatus: InjuryStatus;
  injured: boolean;
  percentOwned: number;
  percentStarted: number;
  projectedWeek: number;
  projectedSeason: number;
  /** ESPN rest-of-season projection (statSplitTypeId 2), 0 if absent */
  projectedRos: number;
  actualWeek: number;
  seasonPoints: number;
  avgPoints: number;
  /** actual points in the last 3 completed games, most recent first */
  recentPts: number[];
  /** ESPN's own positional rank, when present */
  positionRank?: number;
  /** ESPN ownership/added trend */
  percentChange?: number;
}

export interface RosterEntry {
  player: Player;
  lineupSlotId: number;
  acquisitionType?: string;
}

export interface Team {
  id: number;
  name: string;
  abbrev: string;
  ownerIds: string[];
  wins: number;
  losses: number;
  ties: number;
  pointsFor: number;
  pointsAgainst: number;
  waiverRank: number;
  faabRemaining: number;
  roster: RosterEntry[];
}

export interface Matchup {
  id: number;
  week: number;
  homeTeamId: number;
  awayTeamId?: number;
  homeScore: number;
  awayScore: number;
}

export interface LeagueSettings {
  name: string;
  size: number;
  currentWeek: number;
  finalWeek: number;
  /** slotId -> count of starting slots */
  lineupSlots: Record<number, number>;
  usesFaab: boolean;
  faabBudget: number;
  waiverProcessDays: number[];
  tradeDeadlineMs?: number;
}

export interface LeagueSnapshot {
  settings: LeagueSettings;
  teams: Team[];
  matchups: Matchup[];
  fetchedAt: string;
}

export interface FreeAgent extends Player {
  status: "FREEAGENT" | "WAIVERS";
}

export interface PendingTrade {
  id: string;
  /** TRADE_PROPOSAL (awaiting the other side) or TRADE_ACCEPT (accepted, in league review) */
  type: string;
  proposingTeamId: number;
  status: string;
  proposedAt: string;
  expiresAt: string;
  items: { playerId: number; fromTeamId: number; toTeamId: number }[];
}
