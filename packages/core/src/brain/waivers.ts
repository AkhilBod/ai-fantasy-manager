import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { llm, modelId, textOf } from "./llm.js";
import { playerLine, teamBlock, type Ctx } from "./context.js";
import { checkBid, checkDrop } from "../guardrails/rules.js";
import { addFreeAgent, submitWaiverClaim } from "../espn/transactions.js";
import { optimizeLineup } from "./lineup.js";
import { trendingAdds } from "../data/sleeper.js";

export interface WaiverPlan {
  claims: { add: number; drop?: number; bid: number; reason: string }[];
  summary: string;
}

/**
 * Tuesday-night waiver run. Claude reasons with tools; every submit goes
 * through the guardrails and DRY_RUN.
 */
export async function runWaivers(ctx: Ctx): Promise<WaiverPlan> {
  const weekKey = `waivers:${ctx.cfg.season}:${ctx.week}`;
  const state = (await ctx.store.getState<{ spent: number; drops: number }>(weekKey)) ?? { spent: 0, drops: 0 };
  const faabRemaining = ctx.snap.settings.faabBudget - (await ctx.store.getState<number>("faabSpentTotal") ?? 0);
  const trending = await trendingAdds().catch(() => []);
  const trendingSet = new Map(trending.map((t) => [t.espnId, t.count]));

  const fas = ctx.pool.filter((p) => !ctx.snap.teams.some((t) => t.roster.some((e) => e.player.id === p.id)));
  const claims: WaiverPlan["claims"] = [];

  const lineup = optimizeLineup(ctx.me.roster, ctx.snap.settings);
  const droppable = ctx.me.roster
    .map((e) => e.player)
    .filter((p) => !lineup.starters.some((s) => s.player.id === p.id) && !ctx.cfg.untouchables.includes(p.id))
    .sort((a, b) => (ctx.values.get(a.id) ?? 0) - (ctx.values.get(b.id) ?? 0));

  const tools = [
    betaZodTool({
      name: "list_free_agents",
      description: "Top available players by value, optionally filtered by position.",
      inputSchema: z.object({ position: z.enum(["QB", "RB", "WR", "TE", "K", "DST"]).optional(), limit: z.number().max(40).default(20) }),
      run: async ({ position, limit }) =>
        fas.filter((p) => !position || p.position === position)
          .sort((a, b) => (ctx.values.get(b.id) ?? 0) - (ctx.values.get(a.id) ?? 0))
          .slice(0, limit)
          .map((p) => playerLine(ctx, p) + ` [${(p as any).status ?? "FREEAGENT"}]` + (trendingSet.has(p.id) ? ` trending+${trendingSet.get(p.id)}` : ""))
          .join("\n") || "none",
    }),
    betaZodTool({
      name: "submit_claim",
      description: "Submit a waiver claim (or free-agent add if the player is not on waivers). Returns whether guardrails allowed it.",
      inputSchema: z.object({ add: z.number(), drop: z.number().optional(), bid: z.number().min(0), reason: z.string() }),
      run: async ({ add, drop, bid, reason }) => {
        const addP = ctx.players.get(add);
        if (!addP) return `unknown player ${add}`;
        const committed = state.spent + claims.reduce((s, c) => s + c.bid, 0);
        if (!ctx.snap.settings.usesFaab) bid = 0;
        const b = checkBid(bid, faabRemaining, ctx.snap.settings.faabBudget, committed, ctx.rules);
        if (b.ok === false && ctx.snap.settings.usesFaab) return `REJECTED: ${b.reasons.join("; ")}`;
        if (drop != null) {
          const d = checkDrop(drop, state.drops + claims.filter((c) => c.drop != null).length, ctx.cfg, ctx.rules, ctx.players);
          if (!d.ok) return `REJECTED: ${d.reasons.join("; ")}`;
          if (!ctx.me.roster.some((e) => e.player.id === drop)) return `REJECTED: ${drop} not on your roster`;
        } else if (ctx.me.roster.length >= rosterCap(ctx)) {
          return `REJECTED: roster full, you must name a drop`;
        }
        claims.push({ add, drop, bid, reason });
        return `queued: add ${addP.name}${drop ? ` drop ${ctx.players.get(drop)?.name}` : ""} bid ${bid}`;
      },
    }),
  ];

  const prompt = [
    `Today is ${new Date().toLocaleDateString("en-US", { weekday: "long", timeZone: ctx.cfg.timezone })}, NFL week ${ctx.week}. Players marked [WAIVERS] need a FAAB bid and process Wednesday; [FREEAGENT] players add instantly (bid 0) and can play this week. ${ctx.snap.settings.usesFaab ? `FAAB remaining: ${faabRemaining}/${ctx.snap.settings.faabBudget}. Weekly cap ${Math.floor(ctx.snap.settings.faabBudget * ctx.rules.maxFaabPctPerWeek)}.` : `This league uses waiver PRIORITY, not FAAB: always bid 0; my waiver priority is #${ctx.me.waiverRank} of ${ctx.snap.settings.size}, and a successful claim moves me to last.`} Max drops this week: ${ctx.rules.maxDropsPerWeek - state.drops}.`,
    `League: ${ctx.snap.settings.size} teams, starting slots ${JSON.stringify(ctx.snap.settings.lineupSlots)}.`,
    ``,
    `My roster:\n${teamBlock(ctx, ctx.me)}`,
    ``,
    `Droppable (bench, by value asc): ${droppable.map((p) => `${p.name}(${p.id})`).join(", ") || "none"}`,
    ``,
    `Decide which claims to submit, if any. Bid aggressively only for players who'd start for me or have league-winning upside; otherwise bid small or skip. Prefer dropping the lowest-value bench piece at the same position. Use submit_claim for each; up to 3 claims, prioritized. Then reply with a 2-3 sentence summary for a text to me.`,
  ].join("\n");

  const runner = llm().beta.messages.toolRunner({
    model: modelId(),
    max_tokens: 16000,
    output_config: { effort: "high" },
    tools,
    messages: [{ role: "user", content: prompt }],
    max_iterations: 12,
  });
  const final = await runner;
  const summary = textOf(final);

  for (const c of claims) {
    const p = ctx.players.get(c.add)!;
    const isWaiver = (p as any).status === "WAIVERS";
    const tx = { client: ctx.client, teamId: ctx.me.id, week: ctx.week };
    const res = isWaiver ? await submitWaiverClaim(tx, c) : await addFreeAgent(tx, c);
    await ctx.store.logAction({ kind: isWaiver ? "waiver" : "freeagent", summary: `${isWaiver ? "claim" : "add"} ${p.name} bid ${c.bid}${c.drop ? ` drop ${ctx.players.get(c.drop)?.name}` : ""}: ${c.reason}`, dryRun: res.dryRun, payload: c });
  }
  await ctx.store.setState(weekKey, { spent: state.spent + claims.reduce((s, c) => s + c.bid, 0), drops: state.drops + claims.filter((c) => c.drop != null).length });
  return { claims, summary };
}

function rosterCap(ctx: Ctx): number {
  return Object.values(ctx.snap.settings.lineupSlots).reduce((a, b) => a + b, 0) + (ctx.snap.settings.lineupSlots[20] ?? 0);
}
