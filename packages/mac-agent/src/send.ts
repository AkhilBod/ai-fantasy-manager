import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { appendFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
const run = promisify(execFile);

/** Every text the agent sends is logged so the voice exporter never mistakes bot texts for the owner's. */
export const SENT_LOG = resolve(import.meta.dirname, "../../../data/agent-sent.jsonl");
export function logSent(to: string, text: string) {
  mkdirSync(resolve(SENT_LOG, ".."), { recursive: true });
  appendFileSync(SENT_LOG, JSON.stringify({ to, text, at: new Date().toISOString() }) + "\n");
}

/** Send via Messages.app. Needs Automation permission for the calling process. */
export async function sendIMessage(to: string, text: string): Promise<void> {
  const script = `
    on run {targetPhone, msg}
      tell application "Messages"
        set svc to 1st account whose service type = iMessage
        set b to participant targetPhone of svc
        send msg to b
      end tell
    end run`;
  if (process.env.DRY_RUN !== "0" && process.env.DRY_RUN !== "false") {
    console.log(`[imessage:DRY_RUN] → ${to}: ${text}`);
    return;
  }
  await run("osascript", ["-e", script, to, text]);
  logSent(to, text);
}
