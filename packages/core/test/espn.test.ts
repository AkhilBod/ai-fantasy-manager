import { describe, expect, it } from "vitest";
import { EspnClient, parsePlayer } from "../src/espn/client.js";
import { proposeTrade, setLineup, submitWaiverClaim } from "../src/espn/transactions.js";

const creds = { espnS2: "s2", swid: "{ABC}" };

describe("EspnClient", () => {
  it("sends cookies and views, and throws EspnAuthError on 401", async () => {
    const calls: { url: string; init: any }[] = [];
    const fetchImpl = (async (url: any, init: any) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ teams: [], settings: { name: "L" }, scoringPeriodId: 3 }), { status: 200 });
    }) as typeof fetch;
    const c = new EspnClient({ leagueId: 42, season: 2026, creds, fetchImpl });
    const snap = await c.snapshot();
    expect(snap.settings.currentWeek).toBe(3);
    expect(calls[0].url).toContain("/seasons/2026/segments/0/leagues/42?view=mTeam&view=mRoster");
    expect(calls[0].init.headers.Cookie).toBe("espn_s2=s2; SWID={ABC}");

    const bad = new EspnClient({ leagueId: 42, season: 2026, creds, fetchImpl: (async () => new Response("", { status: 401 })) as typeof fetch });
    await expect(bad.snapshot()).rejects.toThrow(/auth/);
  });

  it("parses projections by stat source/split and week", () => {
    const p = parsePlayer({
      id: 7, fullName: "Test Guy", defaultPositionId: 2, proTeamId: 12, eligibleSlots: [2, 23, 20], injuryStatus: "QUESTIONABLE",
      ownership: { percentOwned: 88.5 },
      stats: [
        { statSourceId: 1, statSplitTypeId: 1, scoringPeriodId: 3, appliedTotal: 14.2 },
        { statSourceId: 1, statSplitTypeId: 1, scoringPeriodId: 4, appliedTotal: 9.9 },
        { statSourceId: 1, statSplitTypeId: 0, appliedTotal: 210 },
        { statSourceId: 0, statSplitTypeId: 0, appliedTotal: 40, appliedAverage: 13.3 },
      ],
    }, 3);
    expect(p).toMatchObject({ name: "Test Guy", position: "RB", proTeam: "KC", projectedWeek: 14.2, projectedSeason: 210, avgPoints: 13.3, percentOwned: 88.5, injuryStatus: "QUESTIONABLE" });
  });

  it("ignores other seasons' stat rows when a season is given", () => {
    const p = parsePlayer({ id: 8, fullName: "Two Seasons", defaultPositionId: 3, proTeamId: 12, eligibleSlots: [4], stats: [
      { seasonId: 2025, statSourceId: 0, statSplitTypeId: 0, appliedTotal: 243, appliedAverage: 14.3 },
      { seasonId: 2026, statSourceId: 0, statSplitTypeId: 0, appliedTotal: 26, appliedAverage: 26 },
      { seasonId: 2026, statSourceId: 1, statSplitTypeId: 2, appliedTotal: 226.6 },
    ] }, 3, undefined, 2026);
    expect(p.avgPoints).toBe(26);
    expect(p.projectedRos).toBe(226.6);
  });
});

describe("transactions honor DRY_RUN", () => {
  it("logs but never POSTs when DRY_RUN=1", async () => {
    process.env.DRY_RUN = "1";
    let posted = 0;
    const c = new EspnClient({ leagueId: 1, season: 2026, creds, fetchImpl: (async () => { posted++; return new Response("{}"); }) as typeof fetch });
    const logged: unknown[] = [];
    const ctx = { client: c, teamId: 1, week: 3, log: (_: string, p: unknown) => logged.push(p) };
    await setLineup(ctx, [{ playerId: 5, toSlotId: 0 }]);
    await submitWaiverClaim(ctx, { add: 9, drop: 8, bid: 12 });
    await proposeTrade(ctx, { otherTeamId: 2, give: [1], get: [2, 3] });
    expect(posted).toBe(0);
    expect(logged).toHaveLength(3);
    expect(logged[1]).toMatchObject({ type: "WAIVER", bidAmount: 12, memberId: "{ABC}", items: [{ playerId: 9, type: "ADD" }, { playerId: 8, type: "DROP" }] });
    expect((logged[2] as any).items).toHaveLength(3);
  });
  it("POSTs to the write host when DRY_RUN=0", async () => {
    process.env.DRY_RUN = "0";
    const urls: string[] = [];
    const c = new EspnClient({ leagueId: 1, season: 2026, creds, fetchImpl: (async (u: any) => { urls.push(String(u)); return new Response("{}"); }) as typeof fetch });
    await setLineup({ client: c, teamId: 1, week: 3, log: () => {} }, [{ playerId: 5, toSlotId: 0 }]);
    expect(urls[0]).toBe("https://lm-api-writes.fantasy.espn.com/apis/v3/games/ffl/seasons/2026/segments/0/leagues/1/transactions/");
    process.env.DRY_RUN = "1";
  });
});
