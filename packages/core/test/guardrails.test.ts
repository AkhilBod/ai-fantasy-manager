import { describe, expect, it } from "vitest";
import { checkBid, checkDrop, checkFairness, checkReceivedHealthy, checkTrade, inQuietHours } from "../src/guardrails/rules.js";
import { handleControlMessage, isPaused } from "../src/guardrails/kill-switch.js";
import { LocalStore } from "../src/store/local.js";
import { RulesSchema, type LeagueConfig } from "../src/config.js";
import { player } from "./helpers.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const rules = RulesSchema.parse({
  maxFaabPctPerWeek: 0.35, maxDropsPerWeek: 3, maxOpenTrades: 2, minTradeGainPct: 0.05, protectTopNRanked: 12,
  protectedTradeGainPct: 0.15, maxTextsPerPersonPerDay: 3, maxRepliesPerPersonPerDay: 30, quietHours: { start: 23, end: 8 }, negotiationExpiryDays: 3, maxCounterRounds: 4, autoAcceptIncoming: false, bannedWords: ["nga"], maxMessageWords: 15, maxMessageLines: 2, minLineupDelta: 1, maxSilentProposalsPerDay: 2, silentProposalCooldownDays: 4, unresponsiveCooldownDays: 21, declinedCooldownDays: 14,
});
const cfg: LeagueConfig = { leagueId: 1, season: 2026, myTeamId: 1, timezone: "America/New_York", teams: {}, untouchables: [77], trustedFirst: [] };

describe("checkTrade", () => {
  const a = player({ id: 1, position: "RB", name: "A" }), b = player({ id: 2, position: "WR", name: "B" }), u = player({ id: 77, position: "RB", name: "Untouchable" });
  const players = new Map([[1, a], [2, b], [77, u]]);
  it("rejects lopsided-against-us trades", () => {
    const r = checkTrade({ give: [1], get: [2], values: new Map([[1, 100], [2, 90]]), players }, cfg, rules);
    expect(r.ok).toBe(false);
    expect(r.reasons[0]).toMatch(/value gain/);
  });
  it("accepts trades above the gain floor", () => {
    expect(checkTrade({ give: [1], get: [2], values: new Map([[1, 100], [2, 110]]), players }, cfg, rules).ok).toBe(true);
  });
  it("never gives up untouchables", () => {
    const r = checkTrade({ give: [77], get: [2], values: new Map([[77, 10], [2, 200]]), players }, cfg, rules);
    expect(r.ok).toBe(false);
    expect(r.reasons.join()).toMatch(/untouchable/);
  });
  it("blocks trades that don't improve the starting lineup", () => {
    expect(checkTrade({ give: [1], get: [2], values: new Map([[1, 100], [2, 120]]), players, lineupDelta: -2 }, cfg, rules).ok).toBe(false);
    expect(checkTrade({ give: [1], get: [2], values: new Map([[1, 100], [2, 120]]), players, lineupDelta: 3 }, cfg, rules).ok).toBe(true);
  });
  it("demands a bigger gain for top-ranked players", () => {
    const rosRank = new Map([[1, 5]]);
    expect(checkTrade({ give: [1], get: [2], values: new Map([[1, 100], [2, 108]]), rosRank, players }, cfg, rules).ok).toBe(false);
    expect(checkTrade({ give: [1], get: [2], values: new Map([[1, 100], [2, 120]]), rosRank, players }, cfg, rules).ok).toBe(true);
  });
});

describe("checkFairness", () => {
  const players = new Map([[1, player({ id: 1, position: "RB" })], [2, player({ id: 2, position: "WR" })]]);
  it("allows an edge but blocks a fleecing", () => {
    expect(checkFairness({ give: [1], get: [2], values: new Map([[1, 90], [2, 100]]), players }, rules).ok).toBe(true);
    expect(checkFairness({ give: [1], get: [2], values: new Map([[1, 50], [2, 100]]), players }, rules).ok).toBe(false);
  });
});

describe("checkReceivedHealthy", () => {
  it("refuses OUT / IR players coming to me", () => {
    const players = new Map([[1, player({ id: 1, position: "RB", injuryStatus: "INJURY_RESERVE" })], [2, player({ id: 2, position: "WR", injuryStatus: "QUESTIONABLE" })]]);
    expect(checkReceivedHealthy([2], players).ok).toBe(true);
    expect(checkReceivedHealthy([1, 2], players).ok).toBe(false);
  });
});

describe("checkBid / checkDrop", () => {
  it("caps weekly FAAB", () => {
    expect(checkBid(30, 80, 100, 0, rules).ok).toBe(true);
    expect(checkBid(30, 80, 100, 10, rules).ok).toBe(false);
    expect(checkBid(90, 80, 100, 0, rules).ok).toBe(false);
  });
  it("limits drops and protects untouchables", () => {
    const players = new Map([[77, player({ id: 77, position: "RB" })], [5, player({ id: 5, position: "WR" })]]);
    expect(checkDrop(5, 0, cfg, rules, players).ok).toBe(true);
    expect(checkDrop(5, 3, cfg, rules, players).ok).toBe(false);
    expect(checkDrop(77, 0, cfg, rules, players).ok).toBe(false);
  });
});

describe("quiet hours", () => {
  it("wraps midnight", () => {
    expect(inQuietHours(new Date("2026-09-26T03:30:00Z"), "UTC", rules)).toBe(true); // 03:30
    expect(inQuietHours(new Date("2026-09-26T23:30:00Z"), "UTC", rules)).toBe(true);
    expect(inQuietHours(new Date("2026-09-26T12:00:00Z"), "UTC", rules)).toBe(false);
  });
});

describe("kill switch", () => {
  it("STOP pauses, GO resumes, other text ignored", async () => {
    const s = new LocalStore(join(mkdtempSync(join(tmpdir(), "ffm-")), "store.json"));
    expect(await isPaused(s)).toBe(false);
    expect(await handleControlMessage(s, " stop ")).toBe("paused");
    expect(await isPaused(s)).toBe(true);
    expect(await handleControlMessage(s, "lol")).toBeUndefined();
    expect(await isPaused(s)).toBe(true);
    expect(await handleControlMessage(s, "GO")).toBe("resumed");
    expect(await isPaused(s)).toBe(false);
  });
});
