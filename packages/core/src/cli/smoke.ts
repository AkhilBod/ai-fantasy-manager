import "./_bootstrap.js";
import { EspnClient, loadEspnCredsFromEnv, SLOT_BY_ID } from "../espn/index.js";
import { loadLeagueConfig } from "../config.js";

const cfg = loadLeagueConfig();
const client = new EspnClient({ leagueId: cfg.leagueId, season: cfg.season, creds: loadEspnCredsFromEnv() });
const snap = await client.snapshot();
console.log(`${snap.settings.name} — week ${snap.settings.currentWeek}, ${snap.teams.length} teams, FAAB budget ${snap.settings.faabBudget}`);
const me = snap.teams.find((t) => t.id === cfg.myTeamId);
if (!me) throw new Error(`myTeamId ${cfg.myTeamId} not in league; teams: ${snap.teams.map((t) => `${t.id}=${t.name}`).join(", ")}`);
console.log(`\n${me.name} (${me.wins}-${me.losses})`);
for (const e of [...me.roster].sort((a, b) => a.lineupSlotId - b.lineupSlotId)) {
  const p = e.player;
  console.log(`  ${(SLOT_BY_ID[e.lineupSlotId] ?? e.lineupSlotId).toString().padEnd(6)} ${p.name.padEnd(24)} ${p.position.padEnd(3)} ${p.proTeam.padEnd(4)} proj ${p.projectedWeek.toFixed(1).padStart(5)}  ${p.injuryStatus}`);
}
const fa = await client.freeAgents(snap.settings.currentWeek, { limit: 10 });
console.log(`\nTop free agents by ownership:`);
for (const p of fa) console.log(`  ${p.name.padEnd(24)} ${p.position.padEnd(3)} ${p.proTeam.padEnd(4)} own ${p.percentOwned.toFixed(1)}% proj ${p.projectedWeek.toFixed(1)} [${p.status}]`);
