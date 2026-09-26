import type { EspnClient } from "./client.js";
import { env } from "../config.js";

/**
 * ESPN write payloads. These are undocumented and were derived from browser
 * DevTools. Before flipping DRY_RUN off for a new transaction type, capture one
 * real request in DevTools (Network tab → POST .../transactions/) and compare
 * against the payload logged here.
 */

export interface TxContext {
  client: EspnClient;
  teamId: number;
  week: number;
  log?: (msg: string, payload: unknown) => void;
}

export interface LineupChange {
  playerId: number;
  toSlotId: number;
}

export interface AddDrop {
  add?: number;
  drop?: number;
  bid?: number;
}

export interface TradeProposal {
  otherTeamId: number;
  give: number[];
  get: number[];
  /** players I drop to stay under the roster cap when receiving more than I give */
  drops?: number[];
}

function base(ctx: TxContext, type: string) {
  return {
    isLeagueManager: false,
    teamId: ctx.teamId,
    type,
    memberId: ctx.client.memberId,
    scoringPeriodId: ctx.week,
    executionType: "EXECUTE",
  };
}

async function submit(ctx: TxContext, label: string, payload: unknown): Promise<{ dryRun: boolean; response?: unknown }> {
  (ctx.log ?? defaultLog)(label, payload);
  if (env.dryRun) return { dryRun: true };
  const response = await ctx.client.post("/transactions/", payload);
  return { dryRun: false, response };
}

function defaultLog(label: string, payload: unknown) {
  console.log(`[espn:${env.dryRun ? "DRY_RUN" : "LIVE"}] ${label}`, JSON.stringify(payload));
}

export async function setLineup(ctx: TxContext, changes: LineupChange[]) {
  if (changes.length === 0) return { dryRun: env.dryRun, skipped: true };
  const payload = {
    ...base(ctx, "ROSTER"),
    items: changes.map((c) => ({ playerId: c.playerId, type: "LINEUP", toLineupSlotId: c.toSlotId })),
  };
  return submit(ctx, "setLineup", payload);
}

export async function addFreeAgent(ctx: TxContext, move: AddDrop) {
  const items: unknown[] = [];
  if (move.add != null) items.push({ playerId: move.add, type: "ADD", toTeamId: ctx.teamId });
  if (move.drop != null) items.push({ playerId: move.drop, type: "DROP", fromTeamId: ctx.teamId });
  const payload = { ...base(ctx, "FREEAGENT"), items };
  return submit(ctx, "addFreeAgent", payload);
}

export async function submitWaiverClaim(ctx: TxContext, move: AddDrop) {
  const items: unknown[] = [];
  if (move.add != null) items.push({ playerId: move.add, type: "ADD", toTeamId: ctx.teamId });
  if (move.drop != null) items.push({ playerId: move.drop, type: "DROP", fromTeamId: ctx.teamId });
  const payload = {
    ...base(ctx, "WAIVER"),
    ...(move.bid != null && move.bid > 0 ? { bidAmount: move.bid } : {}),
    items,
  };
  return submit(ctx, "submitWaiverClaim", payload);
}

export async function proposeTrade(ctx: TxContext, trade: TradeProposal) {
  const items = [
    ...trade.give.map((playerId) => ({ playerId, type: "TRADE", fromTeamId: ctx.teamId, toTeamId: trade.otherTeamId })),
    ...trade.get.map((playerId) => ({ playerId, type: "TRADE", fromTeamId: trade.otherTeamId, toTeamId: ctx.teamId })),
    ...(trade.drops ?? []).map((playerId) => ({ playerId, type: "DROP", fromTeamId: ctx.teamId })),
  ];
  const payload = { ...base(ctx, "TRADE_PROPOSAL"), items };
  return submit(ctx, "proposeTrade", payload);
}

/**
 * ESPN has no verified endpoint for accepting/declining a proposal from the API
 * (POST /transactions/{id} returns 405). Declines are a no-op: the offer expires
 * on its own. Accepts are done by proposing the identical trade back so the
 * other manager just taps accept, which uses the verified TRADE_PROPOSAL path.
 */
export async function respondToTrade(ctx: TxContext, trade: { id: string; otherTeamId: number; give: number[]; get: number[]; drops?: number[] }, accept: boolean) {
  if (!accept) {
    (ctx.log ?? defaultLog)("declineTrade(noop)", { id: trade.id });
    return { dryRun: env.dryRun, skipped: true };
  }
  return proposeTrade(ctx, { otherTeamId: trade.otherTeamId, give: trade.give, get: trade.get, drops: trade.drops });
}
