import { POSITION_BY_ID, PRO_TEAM_BY_ID, type InjuryStatus } from "./constants.js";
import type {
  FreeAgent, LeagueSettings, LeagueSnapshot, Matchup, PendingTrade, Player, RosterEntry, Team,
} from "./types.js";

export interface EspnCredentials {
  espnS2: string;
  swid: string;
}

export interface EspnClientOptions {
  leagueId: number;
  season: number;
  creds: EspnCredentials;
  fetchImpl?: typeof fetch;
  readBase?: string;
  writeBase?: string;
}

const READ_BASE = "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl";
const WRITE_BASE = "https://lm-api-writes.fantasy.espn.com/apis/v3/games/ffl";

export class EspnAuthError extends Error {}
export class EspnHttpError extends Error {
  constructor(public status: number, public body: string, url: string) {
    super(`ESPN ${status} for ${url}: ${body.slice(0, 300)}`);
  }
}

/** Thin, typed wrapper over ESPN's undocumented v3 fantasy API. */
export class EspnClient {
  readonly leagueId: number;
  readonly season: number;
  private readonly creds: EspnCredentials;
  private readonly fetchImpl: typeof fetch;
  private readonly readBase: string;
  private readonly writeBase: string;

  constructor(opts: EspnClientOptions) {
    this.leagueId = opts.leagueId;
    this.season = opts.season;
    this.creds = opts.creds;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.readBase = opts.readBase ?? READ_BASE;
    this.writeBase = opts.writeBase ?? WRITE_BASE;
  }

  get leaguePath(): string {
    return `/seasons/${this.season}/segments/0/leagues/${this.leagueId}`;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      Cookie: `espn_s2=${this.creds.espnS2}; SWID=${this.creds.swid}`,
      Accept: "application/json",
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ffm/0.1",
      ...extra,
    };
  }

  async get<T = any>(views: string[], params: Record<string, string | number> = {}, filter?: unknown): Promise<T> {
    const url = new URL(this.readBase + this.leaguePath);
    for (const v of views) url.searchParams.append("view", v);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
    const headers = this.headers(filter ? { "x-fantasy-filter": JSON.stringify(filter) } : {});
    const res = await this.fetchImpl(url, { headers });
    if (res.status === 401 || res.status === 403) throw new EspnAuthError(`ESPN auth failed (${res.status}); refresh espn_s2/SWID`);
    if (!res.ok) throw new EspnHttpError(res.status, await res.text(), url.toString());
    return (await res.json()) as T;
  }

  async post<T = any>(path: string, body: unknown): Promise<T> {
    const url = this.writeBase + this.leaguePath + path;
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: this.headers({ "Content-Type": "application/json" }),
      body: JSON.stringify(body),
    });
    if (res.status === 401 || res.status === 403) throw new EspnAuthError(`ESPN auth failed (${res.status}); refresh espn_s2/SWID`);
    if (!res.ok) throw new EspnHttpError(res.status, await res.text(), url);
    const text = await res.text();
    return (text ? JSON.parse(text) : {}) as T;
  }

  async snapshot(week?: number): Promise<LeagueSnapshot> {
    const raw = await this.get(["mTeam", "mRoster", "mMatchup", "mSettings", "mStatus"], week ? { scoringPeriodId: week } : {});
    const settings = parseSettings(raw);
    const teams: Team[] = (raw.teams ?? []).map((t: any) => parseTeam(t, settings.currentWeek, this.season));
    const matchups: Matchup[] = (raw.schedule ?? []).map((m: any) => ({
      id: m.id,
      week: m.matchupPeriodId,
      homeTeamId: m.home?.teamId,
      awayTeamId: m.away?.teamId,
      homeScore: m.home?.totalPoints ?? 0,
      awayScore: m.away?.totalPoints ?? 0,
    }));
    return { settings, teams, matchups, fetchedAt: new Date().toISOString() };
  }

  async freeAgents(week: number, opts: { limit?: number; slotIds?: number[] } = {}): Promise<FreeAgent[]> {
    const filter = {
      players: {
        filterStatus: { value: ["FREEAGENT", "WAIVERS"] },
        ...(opts.slotIds ? { filterSlotIds: { value: opts.slotIds } } : {}),
        limit: opts.limit ?? 250,
        sortPercOwned: { sortPriority: 1, sortAsc: false },
        filterRanksForScoringPeriodIds: { value: [week] },
      },
    };
    const raw = await this.get(["kona_player_info"], { scoringPeriodId: week }, filter);
    return (raw.players ?? []).map((p: any) => ({
      ...parsePlayer(p.player ?? p, week, p, this.season),
      status: p.status === "WAIVERS" ? "WAIVERS" : "FREEAGENT",
    }));
  }

  async pendingTrades(): Promise<PendingTrade[]> {
    const raw = await this.get(["mPendingTransactions"]);
    return (raw.pendingTransactions ?? [])
      .filter((t: any) => t.type === "TRADE_PROPOSAL" || t.type === "TRADE_ACCEPT")
      .map((t: any) => ({
        id: String(t.id),
        type: t.type,
        proposingTeamId: t.teamId,
        status: t.status,
        proposedAt: new Date(t.proposedDate ?? 0).toISOString(),
        expiresAt: new Date(t.expirationDate ?? 0).toISOString(),
        items: (t.items ?? []).map((i: any) => ({ playerId: i.playerId, fromTeamId: i.fromTeamId, toTeamId: i.toTeamId })),
      }));
  }

  /** The raw SWID with braces, as ESPN expects it in memberId fields. */
  get memberId(): string {
    return this.creds.swid;
  }
}

function parseSettings(raw: any): LeagueSettings {
  const s = raw.settings ?? {};
  const slots: Record<number, number> = {};
  for (const [k, v] of Object.entries(s.rosterSettings?.lineupSlotCounts ?? {})) {
    if ((v as number) > 0) slots[Number(k)] = v as number;
  }
  return {
    name: s.name ?? "",
    size: s.size ?? raw.teams?.length ?? 0,
    currentWeek: raw.scoringPeriodId ?? raw.status?.currentMatchupPeriod ?? 1,
    finalWeek: raw.status?.finalScoringPeriod ?? 17,
    lineupSlots: slots,
    usesFaab: Boolean(s.acquisitionSettings?.isUsingAcquisitionBudget),
    faabBudget: s.acquisitionSettings?.isUsingAcquisitionBudget ? (s.acquisitionSettings?.acquisitionBudget ?? 0) : 0,
    waiverProcessDays: s.acquisitionSettings?.waiverProcessDays ?? [],
    tradeDeadlineMs: s.tradeSettings?.deadlineDate,
  };
}

function parseTeam(t: any, week: number, season?: number): Team {
  const roster: RosterEntry[] = (t.roster?.entries ?? []).map((e: any) => ({
    player: parsePlayer(e.playerPoolEntry?.player ?? e.player, week, e.playerPoolEntry, season),
    lineupSlotId: e.lineupSlotId,
    acquisitionType: e.acquisitionType,
  }));
  return {
    id: t.id,
    name: t.name ?? `${t.location ?? ""} ${t.nickname ?? ""}`.trim(),
    abbrev: t.abbrev ?? "",
    ownerIds: t.owners ?? [],
    wins: t.record?.overall?.wins ?? 0,
    losses: t.record?.overall?.losses ?? 0,
    ties: t.record?.overall?.ties ?? 0,
    pointsFor: t.record?.overall?.pointsFor ?? 0,
    pointsAgainst: t.record?.overall?.pointsAgainst ?? 0,
    waiverRank: t.waiverRank ?? 0,
    faabRemaining: t.transactionCounter?.acquisitionBudgetSpent != null
      ? -1 // filled in by caller from settings if needed
      : 0,
    roster,
  };
}

export function parsePlayer(p: any, week: number, pool?: any, season?: number): Player {
  // ESPN returns rows for several seasons; only this season's rows count.
  const stats: any[] = (p.stats ?? []).filter((s: any) => season == null || s.seasonId === season);
  const find = (sourceId: number, splitType: number, period?: number) =>
    stats.find((s) => s.statSourceId === sourceId && s.statSplitTypeId === splitType && (period == null || s.scoringPeriodId === period));
  const projWeek = find(1, 1, week)?.appliedTotal ?? 0;
  const projSeason = find(1, 0)?.appliedTotal ?? 0;
  const projRos = find(1, 2)?.appliedTotal ?? 0;
  const actualWeek = find(0, 1, week)?.appliedTotal ?? 0;
  const seasonPts = find(0, 0)?.appliedTotal ?? 0;
  const seasonAvg = find(0, 0)?.appliedAverage ?? 0;
  const recentPts = stats.filter((s) => s.statSourceId === 0 && s.statSplitTypeId === 1 && s.scoringPeriodId < week && s.scoringPeriodId > 0)
    .sort((a, b) => b.scoringPeriodId - a.scoringPeriodId).slice(0, 3).map((s) => Math.round((s.appliedTotal ?? 0) * 10) / 10);
  const own = p.ownership ?? pool?.player?.ownership ?? {};
  const rank = pool?.ratings?.[0]?.positionalRanking ?? p.ratings?.[0]?.positionalRanking;
  return {
    id: p.id,
    name: p.fullName ?? `${p.firstName} ${p.lastName}`,
    positionId: p.defaultPositionId,
    position: POSITION_BY_ID[p.defaultPositionId] ?? String(p.defaultPositionId),
    proTeam: PRO_TEAM_BY_ID[p.proTeamId] ?? String(p.proTeamId),
    eligibleSlots: p.eligibleSlots ?? [],
    injuryStatus: (p.injuryStatus as InjuryStatus) ?? "ACTIVE",
    injured: Boolean(p.injured),
    percentOwned: own.percentOwned ?? 0,
    percentStarted: own.percentStarted ?? 0,
    percentChange: own.percentChange,
    projectedWeek: projWeek,
    projectedSeason: projSeason,
    projectedRos: projRos,
    actualWeek,
    seasonPoints: seasonPts,
    avgPoints: seasonAvg,
    recentPts,
    positionRank: rank,
  };
}

export function loadEspnCredsFromEnv(): EspnCredentials {
  const espnS2 = process.env.ESPN_S2;
  const swid = process.env.ESPN_SWID;
  if (!espnS2 || !swid) throw new Error("ESPN_S2 and ESPN_SWID must be set");
  return { espnS2, swid: swid.startsWith("{") ? swid : `{${swid}}` };
}
