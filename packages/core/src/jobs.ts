import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { env, repoRoot, loadRules } from "./config.js";
import { loadCtx, type Ctx } from "./brain/context.js";
import { describeLineup, optimizeLineup } from "./brain/lineup.js";
import { runWaivers } from "./brain/waivers.js";
import { scanTrades } from "./brain/trades.js";
import { handleInbound, openNegotiation, sweepNegotiations, silentProposals, disengagedTeams } from "./brain/negotiate.js";
import { reviewIncomingTrades } from "./brain/incoming.js";
import { setLineup } from "./espn/transactions.js";
import { isPaused, handleControlMessage } from "./guardrails/kill-switch.js";
import { VoiceBundleSchema, type VoiceBundle } from "./voice/types.js";
import { draftMessage } from "./voice/draft.js";
import { store } from "./store/index.js";
import { newId, ACTIVE_STATUSES, type InboundMessage } from "./store/types.js";
import { llm, modelId, textOf, assertNotRefused } from "./brain/llm.js";

/** Voice bundle: S3 in AWS, data/voice-profile.json locally. */
export async function loadVoiceBundle(): Promise<VoiceBundle> {
  const bucket = process.env.PROFILE_BUCKET;
  if (bucket) {
    const s3 = new S3Client({ region: env.region });
    const r = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: "voice-profile.json" }));
    return VoiceBundleSchema.parse(JSON.parse(await r.Body!.transformToString()));
  }
  const p = process.env.VOICE_PROFILE_PATH ?? resolve(repoRoot, "data/voice-profile.json");
  if (!existsSync(p)) throw new Error(`voice profile missing at ${p}; run: npm run voice:build`);
  return VoiceBundleSchema.parse(JSON.parse(readFileSync(p, "utf8")));
}

async function guard(): Promise<boolean> {
  if (await isPaused(store())) { console.log("[jobs] paused by kill switch; skipping"); return false; }
  return true;
}

export async function lineupJob(): Promise<string> {
  if (!(await guard())) return "paused";
  const ctx = await loadCtx({ freeAgentLimit: 0 });
  const result = optimizeLineup(ctx.me.roster, ctx.snap.settings);
  let text = describeLineup(result);
  if (result.flags.length) {
    // Ask Claude only about the genuinely close questionable calls.
    const q = result.flags.map((f) => `${f.starter.name} (${f.starter.injuryStatus}, proj ${f.starter.projectedWeek.toFixed(1)}, ${ctx.sleeper.get(f.starter.id)?.injury_notes ?? "no notes"}) vs ${f.alternative.name} (ACTIVE, proj ${f.alternative.projectedWeek.toFixed(1)})`).join("\n");
    const res = await llm().messages.create({
      model: modelId(), max_tokens: 2000, output_config: { effort: "medium" },
      system: "You are a fantasy football expert deciding start/sit for questionable players. Answer with one line per pair: 'START <name>' or 'START <alternative name>', then a short reason. Prefer the healthy player when the injured one is a game-time decision and the projection gap is small.",
      messages: [{ role: "user", content: `Week ${ctx.week}. Kickoff-sensitive calls:\n${q}` }],
    });
    assertNotRefused(res);
    const answer = textOf(res);
    for (const f of result.flags) {
      const swap = new RegExp(`START\\s+${escapeRe(f.alternative.name)}`, "i").test(answer);
      if (swap) {
        const s = result.starters.find((s) => s.player.id === f.starter.id)!;
        s.player = f.alternative;
        result.changes.push({ playerId: f.alternative.id, toSlotId: f.slotId }, { playerId: f.starter.id, toSlotId: 20 });
      }
    }
    text += `\n\nStart/sit calls:\n${answer}`;
  }
  const r = await setLineup({ client: ctx.client, teamId: ctx.me.id, week: ctx.week }, dedupe(result.changes));
  await ctx.store.logAction({ kind: "lineup", summary: `week ${ctx.week}: ${result.changes.length} change(s), proj ${result.projected.toFixed(1)}`, dryRun: r.dryRun, payload: result.changes });
  return text;
}

export async function waiversJob(): Promise<string> {
  if (!(await guard())) return "paused";
  const ctx = await loadCtx({ freeAgentLimit: 250 });
  const plan = await runWaivers(ctx);
  return `${plan.claims.length} claim(s)\n${plan.summary}`;
}

export async function tradeScanJob(): Promise<string> {
  if (!(await guard())) return "paused";
  const ctx = await loadCtx({ freeAgentLimit: 100 });
  const bundle = await loadVoiceBundle();
  const notes = await sweepNegotiations(ctx, bundle);
  const reviews = await reviewIncomingTrades(ctx, bundle);
  for (const r of reviews) notes.push(`${r.action} offer from team ${r.fromTeamId} (${(r.myGainPct * 100).toFixed(0)}%)`);
  const open = (await ctx.store.listNegotiations({ open: true })).filter((n) => ACTIVE_STATUSES.has(n.status));
  const skip = [...open.map((n) => n.otherTeamId), ...(await disengagedTeams(ctx)).keys()];
  const ideas = await scanTrades(ctx, { excludeTeamIds: skip, maxIdeas: Math.max(2, ctx.rules.maxSilentProposalsPerDay + 1) });
  const opened: string[] = [];
  // Texted offers are rationed (1 per person per week, cap per day); the rest go to ESPN silently.
  const textBudget = Math.max(0, ctx.rules.maxOpenTrades - open.length);
  const leftover: typeof ideas = [];
  for (const idea of ideas) {
    const n = opened.length < textBudget ? await openNegotiation(ctx, bundle, idea) : undefined;
    if (n) opened.push(`texted team ${idea.otherTeamId}: give ${idea.give.length} get ${idea.get.length} (+${(idea.myGainPct * 100).toFixed(0)}%)`);
    else leftover.push(idea);
  }
  const silent = await silentProposals(ctx, leftover);
  return [`sweep: ${notes.join(", ") || "nothing"}`, `ideas: ${ideas.length}`, ...opened, ...silent.map((x) => `silent: ${x}`)].join("\n");
}

/** One inbound iMessage from the Mac agent. */
export async function inboundJob(msg: InboundMessage, opts: { force?: boolean } = {}): Promise<string> {
  const s = store();
  const fresh = await s.recordInbound(msg);
  if (!fresh && !opts.force) return "duplicate";
  const result = await routeInbound(s, msg);
  if (!env.dryRun) await s.setState(`inbound:${msg.id}`, result);
  return result;
}

async function routeInbound(s: ReturnType<typeof store>, msg: InboundMessage): Promise<string> {
  const cfg = (await import("./config.js")).loadLeagueConfig();
  const myPhone = process.env.MY_PHONE ?? Object.values(cfg.teams).find((t) => t.self)?.phone;
  if (msg.isFromMe || msg.phone === myPhone) {
    const ctl = await handleControlMessage(s, msg.text);
    return ctl ?? "own message";
  }
  if (await isPaused(s)) return "paused";
  const teamEntry = Object.entries(cfg.teams).find(([, t]) => t.phone === msg.phone);
  if (!teamEntry) return "not a league member";
  const teamId = Number(teamEntry[0]);
  let thread = (await s.listNegotiations({ open: true, phone: msg.phone }))[0];
  if (!thread) {
    // A thread that closed in the last 24h gets reopened: "and someone else" after a walk-away is still the same conversation.
    const recent = (await s.listNegotiations({ phone: msg.phone }))
      .filter((n) => n.status !== "SUBMITTED" && n.status !== "ACCEPTED" && n.status !== "REJECTED" && n.status !== "PROPOSED" && Date.now() - new Date(n.updatedAt).getTime() < 24 * 3600_000)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    if (recent) { recent.status = "OPENED"; thread = recent; }
  }
  if (!thread) {
    // Unprompted text from a league member: start a thread; the negotiator's own "ignore" handles pure banter.
    thread = {
      id: newId("n_"), otherTeamId: teamId, phone: msg.phone, status: "OPENED", give: [], get: [],
      rationale: "they reached out", initiatedBy: "them", rounds: 0, thread: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + loadRules().negotiationExpiryDays * 86400_000).toISOString(),
    };
  }
  const ctx = await loadCtx({ freeAgentLimit: 50 });
  const bundle = await loadVoiceBundle();
  const result = await handleInbound(ctx, bundle, thread, msg.text);
  await s.logAction({ kind: "system", summary: `inbound from ${teamEntry[1].name}: "${msg.text.slice(0, 80)}" → ${result}`, dryRun: env.dryRun });
  return result;
}

/** Re-process league-mate texts from the last `hours` that never got handled (e.g. the Lambda errored). */
export async function inboxJob(hours = 48): Promise<string> {
  const s = store();
  const since = new Date(Date.now() - hours * 3600_000).toISOString();
  const cfg = (await import("./config.js")).loadLeagueConfig();
  const members = new Set(Object.values(cfg.teams).filter((t) => !t.self).map((t) => t.phone));
  const out: string[] = [];
  const threads = await s.listNegotiations();
  const lastReplyAt = new Map<string, string>();
  for (const n of threads) for (const t of n.thread) if (t.from === "me" && (lastReplyAt.get(n.phone) ?? "") < t.at) lastReplyAt.set(n.phone, t.at);
  const pending: InboundMessage[] = [];
  for (const m of await s.listInbound(since)) {
    if (!members.has(m.phone)) continue;
    // Anything that arrived before my last reply to them has been answered (or deliberately ignored).
    if (m.at <= (lastReplyAt.get(m.phone) ?? "")) continue;
    // Newer than my last reply: unanswered, unless it was deliberately ignored or wasn't theirs.
    const prior = await s.getState<string>(`inbound:${m.id}`);
    if (prior && /^(ignore|own message|duplicate|not a league member|paused|expired)/.test(prior)) continue;
    // "Seen" only counts if I actually replied after it landed in a thread; a suppressed reply leaves it unanswered.
    const seen = threads.some((n) => n.phone === m.phone && n.thread.some((t, i) => t.from === "them" && t.text.toLowerCase().includes(m.text.trim().toLowerCase()) && n.thread.slice(i + 1).some((x) => x.from === "me")));
    if (seen) { if (!env.dryRun) await s.setState(`inbound:${m.id}`, "handled (in thread)"); continue; }
    pending.push(m);
  }
  // Consecutive unanswered texts from the same person become one message so they get one reply, not three.
  const groups = new Map<string, InboundMessage[]>();
  for (const m of pending) (groups.get(m.phone) ?? groups.set(m.phone, []).get(m.phone)!).push(m);
  for (const [phone, msgs] of groups) {
    const name = Object.values(cfg.teams).find((t) => t.phone === phone)?.name ?? phone;
    const combined: InboundMessage = { ...msgs[msgs.length - 1], text: msgs.map((m) => m.text.trim()).join("\n") };
    const r = await inboundJob(combined, { force: true });
    if (!env.dryRun) for (const m of msgs) await s.setState(`inbound:${m.id}`, r);
    out.push(`${name}: "${combined.text.slice(0, 80).replace(/\n/g, " / ")}" → ${r}`);
  }
  return out.join("\n") || "nothing unhandled";
}

export async function dailySummaryJob(): Promise<string> {
  const s = store();
  const cfg = (await import("./config.js")).loadLeagueConfig();
  const myPhone = process.env.MY_PHONE ?? Object.values(cfg.teams).find((t) => t.self)?.phone;
  const since = new Date(Date.now() - 24 * 3600_000).toISOString();
  const actions = await s.listActions(since);
  const open = await s.listNegotiations({ open: true });
  const paused = await isPaused(s);
  const lines = [
    paused ? "PAUSED (text GO to resume)" : env.dryRun ? "mode: DRY RUN" : "mode: LIVE",
    ...actions.map((a) => `${a.at.slice(11, 16)} ${a.kind}: ${a.summary}${a.dryRun ? " (dry)" : ""}`),
    open.length ? `open trades: ${open.map((n) => `team ${n.otherTeamId} [${n.status}]`).join(", ")}` : "no open trades",
  ];
  const text = lines.join("\n").slice(0, 1500);
  if (myPhone) await s.enqueueOutbound({ phone: myPhone, text: `ffm daily:\n${text}` });
  return text;
}

export async function reviewTradesJob(onlyTeamIds?: number[]): Promise<string> {
  if (!(await guard())) return "paused";
  const ctx = await loadCtx({ freeAgentLimit: 50 });
  const bundle = await loadVoiceBundle();
  const reviews = await reviewIncomingTrades(ctx, bundle, { onlyTeamIds });
  if (!reviews.length) return "no new incoming trades";
  return reviews.map((r) => [
    `${ctx.cfg.teams[String(r.fromTeamId)]?.name ?? r.fromTeamId}: ${r.action.toUpperCase()} — get ${r.get.map((id) => ctx.players.get(id)?.name).join(" + ")} for ${r.give.map((id) => ctx.players.get(id)?.name).join(" + ")} (my gain ${(r.myGainPct * 100).toFixed(0)}%)`,
    `  why: ${r.reasoning}`,
    `  espn: ${r.espn}`,
    `  text: ${r.text ?? "(no phone)"}`,
  ].join("\n")).join("\n\n");
}

/** Ad-hoc: draft a message in voice without sending (for the blind test). */
export async function draftOnly(goal: string, recipient = "a league mate"): Promise<string> {
  const bundle = await loadVoiceBundle();
  return (await draftMessage({ bundle, intent: "propose", goal, recipient })).text;
}

function dedupe(changes: { playerId: number; toSlotId: number }[]) {
  const m = new Map<number, number>();
  for (const c of changes) m.set(c.playerId, c.toSlotId);
  return [...m].map(([playerId, toSlotId]) => ({ playerId, toSlotId }));
}
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
