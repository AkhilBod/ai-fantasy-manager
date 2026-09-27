import "./_bootstrap.js";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { repoRoot } from "../config.js";
import { buildVoiceBundle } from "../voice/profile.js";
import { draftMessage } from "../voice/draft.js";
import type { ExportedMessage } from "../voice/types.js";

// Usage: npm run voice:build -- [path/to/messages-export.json]
const input = process.argv[2] ?? resolve(repoRoot, "data/messages-export.json");
const messages = JSON.parse(readFileSync(input, "utf8")) as ExportedMessage[];
console.log(`building profile from ${messages.length} messages…`);
const bundle = await buildVoiceBundle(messages, { maxMessages: 6000 });
mkdirSync(resolve(repoRoot, "data"), { recursive: true });
const out = resolve(repoRoot, "data/voice-profile.json");
writeFileSync(out, JSON.stringify(bundle, null, 2));
console.log(`wrote ${out}\n`);
console.log(bundle.profile.summary);
console.log(`\nSample drafts:`);
for (const goal of [
  "offer my WR2 for their RB2, they need WR help",
  "they countered asking for a throw-in TE, say no but keep the door open",
  "follow up on the offer from two days ago",
]) {
  const d = await draftMessage({ bundle, intent: "propose", goal, recipient: "Ravi, buddy from college" });
  console.log(`- [${goal}]\n  ${d.text}`);
}
