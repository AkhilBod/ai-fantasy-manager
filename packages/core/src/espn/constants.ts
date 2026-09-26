export const POSITION_BY_ID: Record<number, string> = {
  1: "QB", 2: "RB", 3: "WR", 4: "TE", 5: "K", 16: "DST",
};

export const SLOT_BY_ID: Record<number, string> = {
  0: "QB", 2: "RB", 3: "RB/WR", 4: "WR", 5: "WR/TE", 6: "TE", 7: "OP",
  16: "DST", 17: "K", 20: "BE", 21: "IR", 23: "FLEX",
};

export const BENCH_SLOT = 20;
export const IR_SLOT = 21;
export const STARTING_SLOTS = new Set([0, 2, 3, 4, 5, 6, 7, 16, 17, 23]);

export const PRO_TEAM_BY_ID: Record<number, string> = {
  0: "FA", 1: "ATL", 2: "BUF", 3: "CHI", 4: "CIN", 5: "CLE", 6: "DAL", 7: "DEN", 8: "DET",
  9: "GB", 10: "TEN", 11: "IND", 12: "KC", 13: "LV", 14: "LAR", 15: "MIA", 16: "MIN",
  17: "NE", 18: "NO", 19: "NYG", 20: "NYJ", 21: "PHI", 22: "ARI", 23: "PIT", 24: "LAC",
  25: "SF", 26: "SEA", 27: "TB", 28: "WSH", 29: "CAR", 30: "JAX", 33: "BAL", 34: "HOU",
};

export type InjuryStatus =
  | "ACTIVE" | "QUESTIONABLE" | "DOUBTFUL" | "OUT" | "INJURY_RESERVE" | "SUSPENSION" | "UNKNOWN";

export const UNPLAYABLE: ReadonlySet<string> = new Set(["OUT", "INJURY_RESERVE", "SUSPENSION"]);
