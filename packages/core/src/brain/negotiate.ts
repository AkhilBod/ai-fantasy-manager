import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { llm, modelId, assertNotRefused } from "./llm.js";
import { teamBlock, pickDrops, type Ctx } from "./context.js";
import { lineupDelta } from "./context.js";
import { checkTrade, checkFairness, checkReceivedHealthy, inQuietHours } from "../guardrails/rules.js";
import { newsBrief } from "../data/news.js";
import { proposeTrade } from "../espn/transactions.js";
import { draftMessage } from "../voice/draft.js";
import type { VoiceBundle, MessageIntent } from "../voice/types.js";
import { newId, ACTIVE_STATUSES, OPEN_STATUSES, type Negotiation } from "../store/types.js";
import { gain, type TradeIdea } from "./trades.js";
import { env } from "../config.js";

const Decision = z.object({
  action: z.enum(["reply", "counter", "accept", "walk_away", "ignore"]),
  theirOffer: z.object({
    give: z.array(z.number()).describe("player ids I would GIVE under the terms THEY proposed"),
    get: z.array(z.number()).describe("player ids I would GET under the terms THEY proposed"),
  }).optional().describe("the concrete terms THEY proposed in this thread (latest version), if any; resolve names to ids using the rosters"),
  counterGive: z.array(z.number()).optional().describe("player ids I would give in a counter"),
  counterGet: z.array(z.number()).optional(),
  messageGoal: z.string().describe("what the reply text needs to accomplish, in plain words"),
  reasoning: z.string(),
});

export async function openNegotiation(ctx: Ctx, bundle: VoiceBundle, idea: TradeIdea): Promise<Negotiation | undefined> {
  const team = ctx.cfg.teams[String(idea.otherTeamId)];
  if (!team?.phone) { console.log(`[negotiate] no phone for team ${idea.otherTeamId}`); return; }
  const open = (await ctx.store.listNegotiations({ open: true })).filter((n) => ACTIVE_STATUSES.has(n.status));
  if (open.length >= ctx.rules.maxOpenTrades) return;
  if (open.some((n) => n.otherTeamId === idea.otherTeamId)) return;
  if ((await disengagedTeams(ctx)).has(idea.otherTeamId)) { console.log(`[negotiate] team ${idea.otherTeamId} is on the no-offer list`); return; }
  // Don't keep going back to the same person: cooldown after any recent negotiation with them.
  const all = await ctx.store.listNegotiations();
  const cooldownMs = ctx.rules.teamCooldownDays * 86400_000;
  if (all.some((n) => n.otherTeamId === idea.otherTeamId && n.initiatedBy !== "them" && Date.now() - new Date(n.createdAt).getTime() < cooldownMs)) {
    console.log(`[negotiate] team ${idea.otherTeamId} is in cooldown`); return;
  }
  const weekKey = `offers:${ctx.cfg.season}:${ctx.week}`;
  const offersThisWeek = (await ctx.store.getState<number>(weekKey)) ?? 0;
  if (offersThisWeek >= ctx.rules.maxNewOffersPerWeek) { console.log(`[negotiate] weekly new-offer cap reached`); return; }

  const n: Negotiation = {
    id: newId("n_"), otherTeamId: idea.otherTeamId, phone: team.phone, status: "OPENED",
    give: idea.give, get: idea.get, rationale: idea.rationale, rounds: 0, thread: [], initiatedBy: "me",
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + ctx.rules.negotiationExpiryDays * 86400_000).toISOString(),
  };
  const text = await sendInVoice(ctx, bundle, n, "propose", `Offer ${names(ctx, idea.give)} for ${names(ctx, idea.get)}. Pitch: ${idea.pitch}`);
  if (!text) return;
  if (!env.dryRun) { await ctx.store.putNegotiation(n); await ctx.store.setState(weekKey, offersThisWeek + 1); }
  return n;
}

/** Called when a league mate texts. Returns what happened, for logging. */
export async function handleInbound(ctx: Ctx, bundle: VoiceBundle, n: Negotiation, incoming: string): Promise<string> {
  n.thread.push({ from: "them", text: incoming, at: new Date().toISOString() });
  n.updatedAt = new Date().toISOString();
  // A submitted trade they've already accepted on ESPN is finished: close the thread; anything they say now is banter.
  if (n.status === "SUBMITTED" && n.espnTradeId) {
    const o = (await myProposalOutcomes(ctx)).get(n.espnTradeId);
    if (o === "EXECUTED") { n.status = "ACCEPTED"; if (!env.dryRun) await ctx.store.putNegotiation(n); }
    else if (o === "CANCELED") { n.status = "REJECTED"; if (!env.dryRun) await ctx.store.putNegotiation(n); }
  }
  const done = n.status === "ACCEPTED" || n.status === "REJECTED";
  const persist = async () => { if (!env.dryRun) await ctx.store.putNegotiation(n); };
  if (new Date(n.expiresAt) < new Date()) { n.status = "EXPIRED"; await persist(); return "expired"; }

  const other = ctx.snap.teams.find((t) => t.id === n.otherTeamId)!;
  const hasTerms = n.give.length > 0 && n.get.length > 0;
  const news = hasTerms ? await newsBrief(ctx, [...n.give, ...n.get]) : "";
  const res = await llm().messages.parse({
    model: modelId(),
    max_tokens: 4000,
    output_config: { format: zodOutputFormat(Decision), effort: "high" },
    system: [
      "You are negotiating a fantasy football trade over text on behalf of the manager of 'my team'. Decide the next move.",
      "accept = they've agreed to the current terms (or offered something at least as good for me). counter = propose different terms (or first terms, if none yet). reply = keep talking / answer a question / ask what they have in mind, without changing terms. walk_away = they're clearly not interested or it's a bad deal FOR ME. ignore = message doesn't need a response (banter, 'lol').",
      "If THEY propose terms that favor me, that is not a scam: they chose it. Accept it (or lock it in via counter with the exact terms they named). Never walk away from a deal that helps my lineup. Fairness limits only apply to terms I invent.",
      "If they name a player without saying which side it's on, read it from rosters: a player on THEIR roster is what they'd send me. If still unclear, reply asking, don't guess.",
      "They may know a bot is texting for me. Don't deny it, don't discuss it; just talk trades like normal.",
      "Goal = the best STARTING lineup, not the biggest roster. Extra bench bodies are worth ~nothing; 3-for-1s that add depth but weaken a starter are bad. Judge every offer by my weekly starters.",
      "Reply whenever they say something (they started the conversation, so they expect answers); just don't repeat yourself.",
      "Leverage: other managers may be offering things too (see 'other live offers'). You may mention you have other options, truthfully and briefly, to get a better price; take whichever deal is better for me. Never stall on a vague promise ('I might add someone later'): ask them to name it now or move on.",
      hasTerms ? "" : "There are NO terms yet: they reached out first. If they named players, evaluate that as their offer (counter with concrete terms or accept via counter). If they haven't said what they want, reply asking, in one short text.",
      n.status === "SUBMITTED" ? "The trade is ALREADY SUBMITTED on ESPN. Do not accept/counter again. Do NOT restate the terms and NEVER tell them to accept, press accept, or check ESPN; they'll do it when they want. Only reply if they ask a real question; otherwise ignore." : "",
      done ? "This trade is DONE (accepted on ESPN). Do NOT mention the terms, do NOT tell them to accept, do NOT re-propose. Light banter at most; default to ignore." : "",
      `Hard limits: never give more than ${ctx.rules.maxCounterRounds} counters; don't accept anything the value check would reject; be a normal human, not desperate. Be fair: if they say no twice, take the no. Never pressure, guilt, or spam them. Be skeptical: if they suddenly push a player on me, check the news for why (injury, lost job, bye-week dump).`,
    ].filter(Boolean).join("\n"),
    messages: [{
      role: "user",
      content: [
        ctx.committed.size ? `Already committed in a pending ESPN trade, NOT available to offer: ${names(ctx, [...ctx.committed])}. If they ask for one of these, say he's already in a deal.` : "",
        hasTerms ? `Current terms: I give ${names(ctx, n.give)}, I get ${names(ctx, n.get)} (my gain ${(gain(ctx, n.give, n.get) * 100).toFixed(0)}%). Rounds so far: ${n.rounds}. Status: ${n.status}.` : `No terms yet (they texted first). Status: ${n.status}.`,
        `My team:\n${teamBlock(ctx, ctx.me)}`,
        `Their team:\n${teamBlock(ctx, other)}`,
        news ? `Latest news on the players involved:\n${news}` : "",
        await otherLiveOffers(ctx, n),
        `Thread:\n${n.thread.map((t) => `${t.from === "me" ? "ME" : "THEM"}: ${t.text}`).join("\n")}`,
      ].filter(Boolean).join("\n\n"),
    }],
  });
  assertNotRefused(res);
  const d = res.parsed_output;
  if (!d) { await persist(); return "no decision"; }

  let outcome = d.action;
  // Hard rule: a deal THEY proposed that passes my checks gets taken, whatever the model felt about it.
  if (n.status !== "SUBMITTED" && d.theirOffer && d.theirOffer.give.length && d.theirOffer.get.length) {
    const t = d.theirOffer;
    const onMine = t.give.every((id) => ctx.me.roster.some((e) => e.player.id === id));
    const onTheirs = t.get.every((id) => other.roster.some((e) => e.player.id === id));
    const ok = onMine && onTheirs
      && checkTrade({ give: t.give, get: t.get, values: ctx.values, rosRank: ctx.rosRank, players: ctx.players, committed: ctx.committed, lineupDelta: lineupDelta(ctx, t.give, t.get) }, ctx.cfg, ctx.rules).ok
      && checkReceivedHealthy(t.get, ctx.players).ok;
    if (ok && (outcome === "walk_away" || outcome === "reply" || outcome === "counter" || outcome === "ignore")) {
      n.give = t.give; n.get = t.get; outcome = "accept";
      d.messageGoal = `They offered ${names(ctx, t.get)} for ${names(ctx, t.give)} and that works for me: say bet, it's a deal, sending it on ESPN now.`;
    }
  }
  if ((n.status === "SUBMITTED" || done) && (outcome === "accept" || outcome === "counter")) outcome = "reply";
  if (done && outcome === "walk_away") outcome = "ignore";
  if (d.action === "counter") {
    const give = d.counterGive ?? n.give, get = d.counterGet ?? n.get;
    const check = checkTrade({ give, get, values: ctx.values, rosRank: ctx.rosRank, players: ctx.players }, ctx.cfg, ctx.rules);
    const fair = checkFairness({ give, get, values: ctx.values, players: ctx.players }, ctx.rules);
    if (!check.ok || !fair.ok || n.rounds >= ctx.rules.maxCounterRounds) {
      outcome = "walk_away";
      d.messageGoal = `Politely pass on this one for now; keep it friendly. (${[...check.reasons, ...fair.reasons].join("; ") || "too many rounds"})`;
    } else {
      n.give = give; n.get = get; n.rounds += 1; n.status = "COUNTERED";
      d.messageGoal = `Counter: offer ${names(ctx, give)} for ${names(ctx, get)}. ${d.messageGoal}`;
    }
  }
  if (outcome === "accept") {
    const check = checkTrade({ give: n.give, get: n.get, values: ctx.values, rosRank: ctx.rosRank, players: ctx.players, committed: ctx.committed, lineupDelta: lineupDelta(ctx, n.give, n.get) }, ctx.cfg, ctx.rules);
    const healthy = checkReceivedHealthy(n.get, ctx.players);
    if (!check.ok || !healthy.ok) { outcome = "walk_away"; d.messageGoal = `Back out politely: ${[...check.reasons, ...healthy.reasons].join("; ")}`; }
    else {
      n.status = "AGREED";
      const drops = pickDrops(ctx, n.give, n.get);
      const r = await proposeTrade({ client: ctx.client, teamId: ctx.me.id, week: ctx.week }, { otherTeamId: n.otherTeamId, give: n.give, get: n.get, drops });
      n.status = "SUBMITTED";
      n.espnTradeId = (r as any).response?.id ? String((r as any).response.id) : n.espnTradeId;
      await ctx.store.logAction({ kind: "trade_proposal", summary: `submitted trade w/ team ${n.otherTeamId}: give ${names(ctx, n.give)} get ${names(ctx, n.get)}`, dryRun: r.dryRun, payload: { give: n.give, get: n.get } });
      d.messageGoal = `Tell them it's a deal and it's sent on ESPN. Say that once; don't tell them to accept. ${d.messageGoal}`;
    }
  }
  if (outcome === "walk_away") {
    n.status = "WALKED";
    if (n.initiatedBy !== "them") await markDisengaged(ctx, n.otherTeamId, ctx.rules.declinedCooldownDays, "not interested in my offer");
  }
  if (outcome === "reply" && !hasTerms && n.status === "OPENED") n.status = "OPENED";

  if (outcome !== "ignore") {
    const intent: MessageIntent = outcome === "accept" ? "accept" : outcome === "counter" ? "counter" : outcome === "walk_away" ? "decline" : "reply";
    await sendInVoice(ctx, bundle, n, intent, d.messageGoal);
  }
  await persist();
  return `${outcome}: ${d.reasoning}`;
}

/** Nudge stale OPENED/COUNTERED threads once; expire old ones; reconcile ESPN outcomes. */
export async function sweepNegotiations(ctx: Ctx, bundle: VoiceBundle): Promise<string[]> {
  const notes: string[] = [];
  const outcomes = await myProposalOutcomes(ctx);
  for (const n of await ctx.store.listNegotiations({ open: true })) {
    if (n.espnTradeId && outcomes.has(n.espnTradeId)) {
      const o = outcomes.get(n.espnTradeId)!;
      if (o !== "PENDING") {
        n.status = o === "EXECUTED" ? "ACCEPTED" : "REJECTED"; n.updatedAt = new Date().toISOString();
        if (!env.dryRun) await ctx.store.putNegotiation(n);
        if (n.status === "REJECTED" && n.initiatedBy !== "them") await markDisengaged(ctx, n.otherTeamId, ctx.rules.declinedCooldownDays, "rejected my ESPN proposal");
        notes.push(`${n.status.toLowerCase()} on ESPN: team ${n.otherTeamId}`); continue;
      }
    }
    if (n.status === "PROPOSED") continue; // silent ESPN proposal: no texting unless they text first
    const ageH = (Date.now() - new Date(n.updatedAt).getTime()) / 3600_000;
    if (new Date(n.expiresAt) < new Date()) {
      n.status = "EXPIRED"; if (!env.dryRun) await ctx.store.putNegotiation(n); notes.push(`expired ${n.id}`);
      if (n.initiatedBy !== "them" && !n.thread.some((t) => t.from === "them")) await markDisengaged(ctx, n.otherTeamId, ctx.rules.unresponsiveCooldownDays, "never replied to my offer");
      continue;
    }
    const lastMine = n.thread.at(-1)?.from === "me";
    if (lastMine && ageH > 30 && !n.thread.some((t, i) => t.from === "me" && i > 0 && n.thread[i - 1]?.from === "me")) {
      await sendInVoice(ctx, bundle, n, "nudge", "Follow up once, casually, about the offer. Don't be pushy.");
      if (!env.dryRun) await ctx.store.putNegotiation(n);
      notes.push(`nudged ${n.id}`);
    }
  }
  return notes;
}

export async function sendInVoice(ctx: Ctx, bundle: VoiceBundle, n: Negotiation, intent: MessageIntent, goal: string): Promise<string | undefined> {
  const team = ctx.cfg.teams[String(n.otherTeamId)];
  const sent = await ctx.store.countOutboundToday(n.phone, ctx.cfg.timezone);
  // Unsolicited texts (new offers, nudges) get the strict cap; replies to their messages get 3x so a live back-and-forth isn't cut off.
  const unsolicited = intent === "propose" || intent === "nudge";
  const cap = unsolicited ? ctx.rules.maxTextsPerPersonPerDay : ctx.rules.maxRepliesPerPersonPerDay;
  if (sent >= cap) { console.log(`[negotiate] daily text cap (${cap}) hit for ${team?.name}`); return; }
  const draft = await draftMessage({
    bundle, intent, goal,
    recipient: `${team?.name ?? "league mate"} (manages "${ctx.snap.teams.find((t) => t.id === n.otherTeamId)?.name}")`,
    thread: n.thread.map((t) => ({ from: t.from, text: t.text })),
    facts: [...n.give, ...n.get].map((id) => { const p = ctx.players.get(id); return p ? `${p.name}: ${p.position} ${p.proTeam}, avg ${p.avgPoints.toFixed(1)} ppg, ${p.injuryStatus}` : ""; }).filter(Boolean),
    mustMention: ["propose", "counter", "accept"].includes(intent) && n.status !== "ACCEPTED" ? [...n.give, ...n.get].map((id) => ctx.players.get(id)?.name.split(" ").pop() ?? "").filter(Boolean) : undefined,
    knownPlayers: knownPlayerNames(ctx, n.otherTeamId, [...n.give, ...n.get]),
  });
  // Anti-spam: if this says the same thing as something I sent them in the last 2h, don't send it again.
  const recentMine = (await ctx.store.listNegotiations({ phone: n.phone }))
    .flatMap((x) => x.thread).filter((t) => t.from === "me" && Date.now() - new Date(t.at).getTime() < 2 * 3600_000).map((t) => t.text);
  if (recentMine.some((prev) => similar(prev, draft.text))) { console.log(`[negotiate] suppressed near-duplicate to ${team?.name}: ${draft.text}`); return; }
  n.thread.push({ from: "me", text: draft.text, at: new Date().toISOString() });
  n.updatedAt = new Date().toISOString();
  const quiet = inQuietHours(new Date(), ctx.cfg.timezone, ctx.rules);
  if (env.dryRun) {
    console.log(`[imessage:DRY_RUN] → ${team?.name} (${n.phone}): ${draft.text}`);
  } else {
    await ctx.store.enqueueOutbound({ phone: n.phone, text: draft.text, negotiationId: n.id });
  }
  await ctx.store.logAction({ kind: "message", summary: `→ ${team?.name}: ${draft.text}${quiet ? " (queued: quiet hours)" : ""}`, dryRun: env.dryRun });
  return draft.text;
}

export function names(ctx: Ctx, ids: number[]): string {
  return ids.map((id) => ctx.players.get(id)?.name ?? String(id)).join(" + ");
}

/** Word-set Jaccard similarity; two short texts saying the same thing score high. */
export function similar(a: string, b: string): boolean {
  const norm = (t: string) => new Set(t.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter((w) => w.length > 2));
  const A = norm(a), B = norm(b);
  if (A.size === 0 || B.size === 0) return a.trim().toLowerCase() === b.trim().toLowerCase();
  let inter = 0; for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter) >= 0.6;
}

/** What other managers are currently offering, so the model can compare and use it as honest leverage. */
async function otherLiveOffers(ctx: Ctx, n: Negotiation): Promise<string> {
  const others = (await ctx.store.listNegotiations({ open: true })).filter((x) => x.id !== n.id && x.give.length && x.get.length);
  if (!others.length) return "";
  return "Other live offers on the table:\n" + others.map((x) => `- ${ctx.cfg.teams[String(x.otherTeamId)]?.name ?? x.otherTeamId}: I give ${names(ctx, x.give)}, get ${names(ctx, x.get)} [${x.status}]`).join("\n");
}

const COMMON_WORDS = new Set(["brown", "smith", "white", "hall", "hill", "jones", "williams", "johnson", "young", "moore", "allen", "walker", "harris", "davis", "thomas", "taylor", "jackson", "wilson", "james", "adams", "price", "warren", "downs", "london", "reed", "watson", "flowers"]);
/** Last names of every player in the league pool, and the subset the text may reference. */
export function knownPlayerNames(ctx: Ctx, otherTeamId: number, terms: number[]) {
  const last = (name: string) => name.split(" ").pop()!.toLowerCase().replace(/[^a-z]/g, "");
  const all = new Set<string>();
  for (const p of ctx.pool) { const l = last(p.name); if (!COMMON_WORDS.has(l)) all.add(l); }
  const allowed = new Set<string>();
  const other = ctx.snap.teams.find((t) => t.id === otherTeamId);
  for (const e of [...ctx.me.roster, ...(other?.roster ?? [])]) allowed.add(last(e.player.name));
  for (const id of terms) { const p = ctx.players.get(id); if (p) allowed.add(last(p.name)); }
  return { allowed, all };
}

/** Status of every trade proposal I've made this season, by ESPN transaction id. */
export async function myProposalOutcomes(ctx: Ctx): Promise<Map<string, "PENDING" | "EXECUTED" | "CANCELED">> {
  const out = new Map<string, "PENDING" | "EXECUTED" | "CANCELED">();
  try {
    const raw = await ctx.client.get(["mTransactions2", "mPendingTransactions"]);
    for (const t of [...(raw.transactions ?? []), ...(raw.pendingTransactions ?? [])]) {
      if (t.type !== "TRADE_PROPOSAL" || t.teamId !== ctx.me.id) continue;
      // TRADE_ACCEPT = the other side accepted; it's done from a conversation standpoint even while ESPN reviews it.
      const st = t.status === "EXECUTED" || t.type === "TRADE_ACCEPT" ? "EXECUTED" : t.status === "PENDING" || t.status === "ACCEPTED" ? "PENDING" : "CANCELED";
      out.set(String(t.id), st);
    }
  } catch (e) { console.log(`[negotiate] could not read ESPN transactions: ${(e as Error).message.slice(0, 100)}`); }
  return out;
}

/**
 * Silent channel: propose on ESPN with no text. Only when none of my proposals
 * are pending, at most N per day, one per team, and not to a team I proposed
 * to in the last few days. They accept/reject in the app; if they text, the
 * thread picks it up.
 */
export async function silentProposals(ctx: Ctx, ideas: TradeIdea[]): Promise<string[]> {
  const notes: string[] = [];
  const outcomes = await myProposalOutcomes(ctx);
  if ([...outcomes.values()].some((s) => s === "PENDING")) { notes.push("skipped: I already have a proposal pending on ESPN"); return notes; }
  const dayKey = `silent:${new Date().toISOString().slice(0, 10)}`;
  let sentToday = (await ctx.store.getState<number>(dayKey)) ?? 0;
  const all = await ctx.store.listNegotiations();
  const cooldownMs = ctx.rules.silentProposalCooldownDays * 86400_000;
  const disengaged = await disengagedTeams(ctx);
  for (const idea of ideas) {
    if (sentToday >= ctx.rules.maxSilentProposalsPerDay) break;
    if (disengaged.has(idea.otherTeamId)) continue;
    if (all.some((n) => n.otherTeamId === idea.otherTeamId && (OPEN_STATUSES.has(n.status) || Date.now() - new Date(n.createdAt).getTime() < cooldownMs))) continue;
    const drops = pickDrops(ctx, idea.give, idea.get);
    const r = await proposeTrade({ client: ctx.client, teamId: ctx.me.id, week: ctx.week }, { otherTeamId: idea.otherTeamId, give: idea.give, get: idea.get, drops });
    const n: Negotiation = {
      id: newId("n_"), otherTeamId: idea.otherTeamId, phone: ctx.cfg.teams[String(idea.otherTeamId)]?.phone ?? "", status: "PROPOSED",
      give: idea.give, get: idea.get, rationale: `silent ESPN proposal: ${idea.rationale}`, initiatedBy: "me", rounds: 0, thread: [],
      espnTradeId: (r as any).response?.id ? String((r as any).response.id) : undefined,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + ctx.rules.negotiationExpiryDays * 86400_000).toISOString(),
    };
    if (!env.dryRun) { await ctx.store.putNegotiation(n); await ctx.store.setState(dayKey, ++sentToday); } else sentToday++;
    await ctx.store.logAction({ kind: "trade_proposal", summary: `silent ESPN proposal to team ${idea.otherTeamId}: give ${names(ctx, idea.give)} get ${names(ctx, idea.get)}${drops.length ? ` drop ${names(ctx, drops)}` : ""} (lineup +${idea.myGainPct ? (idea.myGainPct * 100).toFixed(0) + "%" : "?"})`, dryRun: r.dryRun });
    notes.push(`proposed on ESPN to team ${idea.otherTeamId}: ${names(ctx, idea.give)} for ${names(ctx, idea.get)}`);
  }
  return notes;
}

/** Teams that have shown they're not interested (ignored an offer, or said no): no offers until the date. */
export async function disengagedTeams(ctx: Ctx): Promise<Map<number, string>> {
  const m = new Map<number, string>();
  for (const t of ctx.snap.teams) {
    const until = await ctx.store.getState<string>(`disengaged:${t.id}`);
    if (until && new Date(until) > new Date()) m.set(t.id, until);
  }
  return m;
}
export async function markDisengaged(ctx: Ctx, teamId: number, days: number, why: string): Promise<void> {
  const until = new Date(Date.now() + days * 86400_000).toISOString();
  if (!env.dryRun) await ctx.store.setState(`disengaged:${teamId}`, until);
  await ctx.store.logAction({ kind: "system", summary: `no more offers to ${ctx.cfg.teams[String(teamId)]?.name ?? teamId} until ${until.slice(0, 10)}: ${why}`, dryRun: env.dryRun });
}
