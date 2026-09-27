import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { myMessages, normalizePhone, openChatDb } from "./chatdb.js";

/**
 * Exports your own messages, anonymized, to data/messages-export.json.
 * Tags each as league / leaguemate / other using config/league.json.
 * Run on the Mac:  npm run export -w @ffm/mac-agent
 */
const root = resolve(import.meta.dirname, "../../..");
const cfgPath = resolve(root, "config/league.json");
const cfg = existsSync(cfgPath) ? JSON.parse(readFileSync(cfgPath, "utf8")) : { teams: {}, leagueGroupChatName: "" };
const phones = new Set(Object.values(cfg.teams as Record<string, { phone?: string; self?: boolean }>).filter((t) => !t.self && t.phone).map((t) => normalizePhone(t.phone!)));
// Chat names carry emoji and stray spaces; compare on letters/digits only.
const norm = (t: string | null | undefined) => (t ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
const groupName = norm(cfg.leagueGroupChatName as string | undefined);

// Texts the agent itself sent from this phone are not the owner's voice.
const sentLog = resolve(root, "data/agent-sent.jsonl");
const normText = (t: string) => t.toLowerCase().replace(/\s+/g, " ").trim();
const botTexts = new Set(existsSync(sentLog) ? readFileSync(sentLog, "utf8").split("\n").filter(Boolean).map((l) => normText(JSON.parse(l).text)) : []);
const db = openChatDb();
const rows = myMessages(db, Number(process.env.EXPORT_LIMIT ?? 40000));
const out = rows
  .filter((r) => !/^(https?:\/\/\S+|\s*)$/.test(r.text) && r.text.length <= 600)
  .filter((r) => !botTexts.has(normText(r.text)) && !/^ffm daily:/.test(r.text))
  .map((r) => ({
    text: r.text,
    chat: groupName && norm(r.chatName).includes(groupName) ? "league"
      : phones.has(normalizePhone(r.handle)) || (r.chatGuid ?? "").split(";").some((h) => phones.has(normalizePhone(h))) ? "leaguemate"
      : "other",
    at: r.date,
  }));
mkdirSync(resolve(root, "data"), { recursive: true });
const dest = resolve(root, "data/messages-export.json");
writeFileSync(dest, JSON.stringify(out, null, 1));
const counts = out.reduce((m, r) => (m[r.chat] = (m[r.chat] ?? 0) + 1, m), {} as Record<string, number>);
console.log(`wrote ${out.length} messages to ${dest}`, counts, `| excluded ${rows.length - out.length} (bot-sent, links, empty, too long)`);
console.log("This file contains your own texts only. Review it, then: npm run voice:build");
