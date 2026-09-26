import { describe, expect, it } from "vitest";
import { playerValue, replacementLevel } from "../src/valuation/player-value.js";
import { player, settings } from "./helpers.js";

describe("playerValue", () => {
  const pool = [
    ...Array.from({ length: 30 }, (_, i) => player({ position: "RB", projectedSeason: 250 - i * 6 })),
    ...Array.from({ length: 30 }, (_, i) => player({ position: "WR", projectedSeason: 240 - i * 5 })),
    ...Array.from({ length: 12 }, (_, i) => player({ position: "QB", projectedSeason: 330 - i * 10 })),
  ];
  const inputs = { currentWeek: 4, finalWeek: 17 };
  it("is replacement-adjusted: a replacement-level player is worth ~0", () => {
    const repl = replacementLevel(pool, settings, "RB");
    const p = player({ position: "RB", projectedSeason: repl });
    expect(playerValue(p, pool, settings, inputs)).toBeCloseTo(0, 0);
  });
  it("rewards scarcity: QB1 is not worth more than RB1 just because QBs score more", () => {
    const qb1 = pool.find((p) => p.position === "QB")!, rb1 = pool.find((p) => p.position === "RB")!;
    expect(playerValue(rb1, pool, settings, inputs)).toBeGreaterThan(playerValue(qb1, pool, settings, inputs) * 0.8);
  });
  it("discounts injured players and premiums consensus top-12", () => {
    const base = player({ position: "RB", projectedSeason: 240 });
    const out = { ...base, injuryStatus: "OUT" as const };
    expect(playerValue(out, pool, settings, inputs)).toBeLessThan(playerValue(base, pool, settings, inputs));
    expect(playerValue(base, pool, settings, { ...inputs, rosRank: new Map([[base.id, 3]]) })).toBeGreaterThan(playerValue(base, pool, settings, inputs));
  });
  it("shrinks as the season runs out", () => {
    const p = player({ position: "WR", projectedSeason: 240 });
    expect(playerValue(p, pool, settings, { currentWeek: 14, finalWeek: 17 })).toBeLessThan(playerValue(p, pool, settings, inputs));
  });
});
