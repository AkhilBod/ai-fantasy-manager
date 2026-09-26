import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { DeleteMessageCommand, ReceiveMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { maxRowid, messagesAfter, normalizePhone, openChatDb } from "./chatdb.js";
import { sendIMessage } from "./send.js";

/**
 * Mac bridge. Two loops:
 *  1. poll chat.db → POST new messages from league mates (and from me) to the inbound API
 *  2. long-poll SQS → send iMessages
 * Runs forever; install via launchd (see launchd.plist).
 */
const root = resolve(import.meta.dirname, "../../..");
loadDotEnv(resolve(root, ".env"));
const cfg = JSON.parse(readFileSync(resolve(root, "config/league.json"), "utf8"));
const watch = new Set<string>(Object.values(cfg.teams as Record<string, { phone?: string }>).flatMap((t) => (t.phone ? [normalizePhone(t.phone)] : [])));
const myPhone = normalizePhone(process.env.MY_PHONE ?? Object.values(cfg.teams as Record<string, { phone?: string; self?: boolean }>).find((t) => t.self)?.phone ?? "");
const API = must("INBOUND_API_URL");
const SECRET = must("INBOUND_API_SECRET");
const QUEUE = process.env.OUTBOUND_QUEUE_URL;
const statePath = resolve(root, "data/mac-agent-state.json");
mkdirSync(resolve(root, "data"), { recursive: true });
let lastRowid = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")).lastRowid : undefined;

const db = openChatDb();
if (lastRowid == null) { lastRowid = maxRowid(db); save(); }
console.log(`[mac-agent] watching ${watch.size} numbers from rowid ${lastRowid}; queue ${QUEUE ? "on" : "off"}; DRY_RUN=${process.env.DRY_RUN ?? "1"}`);

async function pollInbound() {
  for (const r of messagesAfter(db, lastRowid)) {
    lastRowid = r.rowid;
    const phone = normalizePhone(r.handle);
    const relevant = r.isFromMe ? phone === myPhone || phone === "" : watch.has(phone);
    if (!relevant) continue;
    // Ignore group chats: negotiation is 1:1 only.
    if ((r.chatGuid ?? "").includes(";chat")) continue;
    const body = { id: r.guid, phone: r.isFromMe ? myPhone : phone, text: r.text, isFromMe: r.isFromMe, chatName: r.chatName ?? undefined, at: r.date };
    try {
      const res = await fetch(API, { method: "POST", headers: { "content-type": "application/json", "x-ffm-secret": SECRET }, body: JSON.stringify(body) });
      const txt = (await res.text()).slice(0, 80);
      console.log(`[inbound] ${r.isFromMe ? "me" : phone}: "${r.text.slice(0, 60)}" → ${res.status} ${txt}`);
      if (res.status >= 500) { console.error("[inbound] server error; will retry"); lastRowid = r.rowid - 1; break; }
    } catch (e) {
      console.error("[inbound] post failed", e);
      lastRowid = r.rowid - 1; // retry next tick
      break;
    }
  }
  save();
}

async function pollOutbound() {
  if (!QUEUE) return;
  if (process.env.DRY_RUN !== "0" && process.env.DRY_RUN !== "false") {
    console.log("[outbound] DRY_RUN=1: not consuming the queue, so live messages are not lost. Set DRY_RUN=0 to send.");
    return;
  }
  const ak = process.env.FFM_MAC_AWS_ACCESS_KEY_ID, sk = process.env.FFM_MAC_AWS_SECRET_ACCESS_KEY;
  const sqs = new SQSClient({ region: process.env.AWS_REGION ?? "us-east-1", ...(ak && sk ? { credentials: { accessKeyId: ak, secretAccessKey: sk } } : {}) });
  for (;;) {
    try {
      const r = await sqs.send(new ReceiveMessageCommand({ QueueUrl: QUEUE, MaxNumberOfMessages: 5, WaitTimeSeconds: 20 }));
      for (const m of r.Messages ?? []) {
        const msg = JSON.parse(m.Body ?? "{}") as { phone: string; text: string };
        if (inQuietHours()) { console.log("[outbound] quiet hours; leaving in queue"); await sleep(5 * 60_000); break; }
        await sendIMessage(msg.phone, msg.text);
        console.log(`[outbound] → ${msg.phone}: ${msg.text}`);
        await sqs.send(new DeleteMessageCommand({ QueueUrl: QUEUE, ReceiptHandle: m.ReceiptHandle }));
        await sleep(3000);
      }
    } catch (e) {
      console.error("[outbound] error", e);
      await sleep(15_000);
    }
  }
}

function inQuietHours(): boolean {
  const rules = JSON.parse(readFileSync(resolve(root, "config/rules.json"), "utf8"));
  const hour = Number(new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false, timeZone: cfg.timezone ?? "America/New_York" }).format(new Date()));
  const { start, end } = rules.quietHours;
  return start > end ? hour >= start || hour < end : hour >= start && hour < end;
}

function save() { writeFileSync(statePath, JSON.stringify({ lastRowid })); }
function must(k: string): string { const v = process.env[k]; if (!v) throw new Error(`${k} not set`); return v; }
function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }
function loadDotEnv(p: string) {
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] == null) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
  }
}

void pollOutbound();
for (;;) { await pollInbound(); await sleep(15_000); }
