import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { llm, modelId, assertNotRefused } from "./llm.js";
import { teamBlock, positionalNeeds, pickDrops, type Ctx } from "./context.js";
import { lineupDelta } from "./context.js";
import { checkTrade, checkReceivedHealthy } from "../guardrails/rules.js";
import { newsBrief } from "../data/news.js";
import { proposeTrade, respondToTrade } from "../espn/transactions.js";
import type { VoiceBundle } from "../voice/types.js";
import { newId, type Negotiation } from "../store/types.js";
import { gain } from "./trades.js";
import { names, sendInVoice } from "./negotiate.js";
import { env } from "../config.js";

const Decision = z.object({
  action: z.enum(["accept", "counter", "reject"]),
  counterGive: z.array(z.number()).optional().describe("player ids I give in the counter"),
  counterGet: z.array(z.number()).optional().describe("player ids I get in the counter"),
  messageGoal: z.string().describe("what to say to them, plain words: my honest take + what I'd do instead"),
  reasoning: z.string(),
});

export interface IncomingReview {
  tradeId: string;
  fromTeamId: number;
  give: number[];
  get: number[];
  myGainPct: number;
  action: "accept" | "counter" | "reject";
  reasoning: string;
  text?: string;
  espn?: string;
}

/** Review trade proposals other managers sent me on ESPN; respond on ESPN and by text. */
export async function reviewIncomingTrades(ctx: Ctx, bundle: VoiceBundle, opts: { onlyTeamIds?: number[]; allowAccept?: boolean } = {}): Promise<IncomingReview[]> {
  const allowAccept = opts.allowAccept ?? ctx.rules.autoAcceptIncoming;
  const pending = (await ctx.client.pendingTrades()).filter((t) => t.type === "TRADE_PROPOSAL" && t.proposingTeamId !== ctx.me.id && t.items.some((i) => i.toTeamId === ctx.me.id || i.fromTeamId === ctx.me.id));
  const out: IncomingReview[] = [];
  for (const t of pending) {
    if (opts.onlyTeamIds && !opts.onlyTeamIds.includes(t.proposingTeamId)) continue;
    const reviewedKey = `incoming:${t.id}`;
    if (await ctx.store.getState<boolean>(reviewedKey)) continue;
    const give = t.items.filter((i) => i.fromTeamId === ctx.me.id).map((i) => i.playerId);
    const get = t.items.filter((i) => i.toTeamId === ctx.me.id).map((i) => i.playerId);
    const other = ctx.snap.teams.find((x) => x.id === t.proposingTeamId)!;
    const check = checkTrade({ give, get, values: ctx.values, rosRank: ctx.rosRank, players: ctx.players }, ctx.cfg, ctx.rules);
    const healthy = checkReceivedHealthy(get, ctx.players);
    const news = await newsBrief(ctx, [...give, ...get]);

    const res = await llm().messages.parse({
      model: modelId(),
      max_tokens: 4000,
      output_config: { format: zodOutputFormat(Decision), effort: "high" },
      system: [
        "You are a sharp, slightly skeptical fantasy football manager reviewing a trade someone sent you. Decide accept / counter / reject.",
        "Accept only if it clearly improves my starting lineup rest-of-season. Counter when the idea has merit but the price is off: ask for the piece that fixes it. Reject bad offers plainly but stay friendly, they're a friend.",
        "The value check is a hard rule: if it fails, you cannot accept as-is. Be suspicious by default: ask yourself WHY they're offering this. Check the news for hidden injuries, lost jobs, suspensions, or bye-week dumps before you value any player they're sending.",
        `Accepting requires at least ${Math.round(ctx.rules.acceptIncomingMinGainPct * 100)}% value gain for me AND a clear lineup upgrade; otherwise counter.`,
        allowAccept ? "" : "Accepting as-is is NOT available to you right now: choose counter or reject. If the offer is genuinely good, counter for a small sweetener (a bench upgrade, a pick-style throw-in) rather than rejecting, and say in the message that you're close.",
      ].filter(Boolean).join("\n"),
      messages: [{
        role: "user",
        content: [
          `Week ${ctx.week}. ${other.name} (${ctx.cfg.teams[String(other.id)]?.name}) offers: I GIVE ${names(ctx, give)} and GET ${names(ctx, get)}. My value gain: ${(gain(ctx, give, get) * 100).toFixed(0)}%. Value check: ${check.ok ? "PASS" : "FAIL: " + check.reasons.join("; ")}. Health check on what I'd receive: ${healthy.ok ? "PASS" : "FAIL: " + healthy.reasons.join("; ")}.`,
          news ? `Latest news:\n${news}` : "",
          `My team:\n${teamBlock(ctx, ctx.me)}\nMy positional values: ${positionalNeeds(ctx, ctx.me)}`,
          `Their team:\n${teamBlock(ctx, other)}\nTheir positional values: ${positionalNeeds(ctx, other)}`,
        ].join("\n\n"),
      }],
    });
    assertNotRefused(res);
    const d = res.parsed_output;
    if (!d) continue;
    let action = d.action;
    if (action === "accept" && (!check.ok || !healthy.ok)) action = "reject";
    if (action === "accept" && !allowAccept) action = "counter";
    if (action === "accept" && gain(ctx, give, get) < ctx.rules.acceptIncomingMinGainPct) { action = "counter"; d.messageGoal = `Close but not quite; ask for a small add. ${d.messageGoal}`; }
    let cGive = d.counterGive ?? [], cGet = d.counterGet ?? [];
    if (action === "counter") {
      const cc = checkTrade({ give: cGive, get: cGet, values: ctx.values, rosRank: ctx.rosRank, players: ctx.players, mode: "respond", committed: ctx.committed, lineupDelta: lineupDelta(ctx, cGive, cGet) }, ctx.cfg, ctx.rules);
      const valid = cc.ok && cGive.every((id) => ctx.me.roster.some((e) => e.player.id === id)) && cGet.every((id) => other.roster.some((e) => e.player.id === id));
      if (!valid) { action = "reject"; d.messageGoal = `Pass on this one, friendly. ${d.messageGoal}`; }
    }

    const review: IncomingReview = { tradeId: t.id, fromTeamId: t.proposingTeamId, give, get, myGainPct: gain(ctx, give, get), action, reasoning: d.reasoning };
    const tx = { client: ctx.client, teamId: ctx.me.id, week: ctx.week };
    try {
      const ref = { id: t.id, otherTeamId: other.id, give, get, drops: pickDrops(ctx, give, get) };
      if (action === "accept") { await respondToTrade(tx, ref, true); review.espn = "mirrored proposal sent for them to accept"; }
      else if (action === "reject") { await respondToTrade(tx, ref, false); review.espn = "left to expire on ESPN"; }
      else { await proposeTrade(tx, { otherTeamId: other.id, give: cGive, get: cGet, drops: pickDrops(ctx, cGive, cGet) }); review.espn = "counter proposed on ESPN"; }
    } catch (e) {
      review.espn = `ESPN response failed (${(e as Error).message.slice(0, 120)}); respond manually on ESPN`;
    }

    const team = ctx.cfg.teams[String(other.id)];
    if (team?.phone) {
      const n: Negotiation = {
        id: newId("n_"), otherTeamId: other.id, phone: team.phone, status: action === "counter" ? "COUNTERED" : action === "accept" ? "SUBMITTED" : "WALKED",
        give: action === "counter" ? cGive : give, get: action === "counter" ? cGet : get, rationale: d.reasoning, initiatedBy: "them", rounds: action === "counter" ? 1 : 0, thread: [],
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + ctx.rules.negotiationExpiryDays * 86400_000).toISOString(),
      };
      const goal = action === "counter" ? `Their offer (${names(ctx, get)} for ${names(ctx, give)}) doesn't work for me; counter with ${names(ctx, cGet)} for ${names(ctx, cGive)}. ${d.messageGoal}`
        : action === "accept" ? `Accept their offer of ${names(ctx, get)} for ${names(ctx, give)}. ${d.messageGoal}`
        : `Turn down their offer of ${names(ctx, get)} for ${names(ctx, give)}. ${d.messageGoal}`;
      review.text = await sendInVoice(ctx, bundle, n, action === "accept" ? "accept" : action === "counter" ? "counter" : "decline", goal);
      if (action === "counter" && !env.dryRun) await ctx.store.putNegotiation(n);
    }
    if (!env.dryRun) await ctx.store.setState(reviewedKey, true);
    await ctx.store.logAction({ kind: "trade_response", summary: `${action} offer from ${team?.name ?? other.name}: get ${names(ctx, get)} for ${names(ctx, give)} (${(review.myGainPct * 100).toFixed(0)}%) ${review.espn ?? ""}`, dryRun: env.dryRun });
    out.push(review);
  }
  return out;
}
