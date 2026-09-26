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
const groupName = (cfg.leagueGroupChatName as string | undefined)?.toLowerCase();

const db = openChatDb();
const rows = myMessages(db, Number(process.env.EXPORT_LIMIT ?? 20000));
const out = rows
  .filter((r) => !/^(https?:\/\/\S+|\s*)$/.test(r.text) && r.text.length <= 600)
  .map((r) => ({
    text: r.text,
    chat: groupName && r.chatName?.toLowerCase() === groupName ? "league"
      : phones.has(normalizePhone(r.handle)) || (r.chatGuid ?? "").split(";").some((h) => phones.has(normalizePhone(h))) ? "leaguemate"
      : "other",
    at: r.date,
  }));
mkdirSync(resolve(root, "data"), { recursive: true });
const dest = resolve(root, "data/messages-export.json");
writeFileSync(dest, JSON.stringify(out, null, 1));
const counts = out.reduce((m, r) => (m[r.chat] = (m[r.chat] ?? 0) + 1, m), {} as Record<string, number>);
console.log(`wrote ${out.length} messages to ${dest}`, counts);
console.log("This file contains your own texts only. Review it, then: npm run voice:build");
