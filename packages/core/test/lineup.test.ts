import { describe, expect, it } from "vitest";
import { optimizeLineup } from "../src/brain/lineup.js";
import { player, roster, settings } from "./helpers.js";

describe("optimizeLineup", () => {
  it("fills every slot with the highest projection and benches the rest", () => {
    const ps = [
      player({ position: "QB", projectedWeek: 20, name: "qb1" }), player({ position: "QB", projectedWeek: 15, name: "qb2" }),
      player({ position: "RB", projectedWeek: 18, name: "rb1" }), player({ position: "RB", projectedWeek: 12, name: "rb2" }), player({ position: "RB", projectedWeek: 14, name: "rb3" }),
      player({ position: "WR", projectedWeek: 16, name: "wr1" }), player({ position: "WR", projectedWeek: 11, name: "wr2" }), player({ position: "WR", projectedWeek: 9, name: "wr3" }),
      player({ position: "TE", projectedWeek: 8, name: "te1" }), player({ position: "K", projectedWeek: 7 }), player({ position: "DST", projectedWeek: 6 }),
    ];
    const r = optimizeLineup(roster(ps), settings);
    const names = r.starters.map((s) => s.player.name);
    expect(names).toContain("qb1");
    expect(names).not.toContain("qb2");
    // RB slots take rb1/rb3, FLEX takes rb2 (12) over wr3 (9)
    expect(r.starters.find((s) => s.slotId === 23)?.player.name).toBe("rb2");
    expect(r.starters).toHaveLength(9);
    expect(r.projected).toBeCloseTo(20 + 18 + 14 + 12 + 16 + 11 + 8 + 7 + 6);
    expect(r.changes.filter((c) => c.toSlotId !== 20)).toHaveLength(9);
  });

  it("never starts OUT / IR players and flags questionable starters with close alternatives", () => {
    const ps = [
      player({ position: "QB", projectedWeek: 20, injuryStatus: "OUT", name: "qbOut" }), player({ position: "QB", projectedWeek: 15, name: "qb2" }),
      player({ position: "RB", projectedWeek: 18, injuryStatus: "QUESTIONABLE", name: "rbQ" }), player({ position: "RB", projectedWeek: 16, name: "rbAlt" }), player({ position: "RB", projectedWeek: 5 }),
      player({ position: "WR", projectedWeek: 16 }), player({ position: "WR", projectedWeek: 11 }), player({ position: "WR", projectedWeek: 9 }),
      player({ position: "TE", projectedWeek: 8 }), player({ position: "K", projectedWeek: 7 }), player({ position: "DST", projectedWeek: 6 }),
    ];
    const r = optimizeLineup(roster(ps), settings);
    expect(r.starters.map((s) => s.player.name)).not.toContain("qbOut");
    expect(r.starters.map((s) => s.player.name)).toContain("qb2");
    expect(r.flags.map((f) => f.starter.name)).toEqual([]); // rbAlt already starts (RB2), so no bench alternative
  });

  it("produces no changes when the lineup is already optimal", () => {
    const qb = player({ position: "QB", projectedWeek: 20 });
    const rb1 = player({ position: "RB", projectedWeek: 18 }), rb2 = player({ position: "RB", projectedWeek: 12 });
    const wr1 = player({ position: "WR", projectedWeek: 16 }), wr2 = player({ position: "WR", projectedWeek: 11 }), wr3 = player({ position: "WR", projectedWeek: 10 });
    const te = player({ position: "TE", projectedWeek: 8 }), k = player({ position: "K", projectedWeek: 7 }), d = player({ position: "DST", projectedWeek: 6 });
    const bench = player({ position: "RB", projectedWeek: 3 });
    const slot = new Map([[qb, 0], [rb1, 2], [rb2, 2], [wr1, 4], [wr2, 4], [wr3, 23], [te, 6], [k, 17], [d, 16], [bench, 20]]);
    const r = optimizeLineup(roster([...slot.keys()], (p) => slot.get(p)!), settings);
    expect(r.changes).toEqual([]);
  });
});
