import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { repoRoot } from "../config.js";

// Minimal .env loader so CLIs work without extra deps.
const envPath = resolve(repoRoot, ".env");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] == null) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
  }
}
