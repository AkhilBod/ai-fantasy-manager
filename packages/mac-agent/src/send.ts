import { execFile } from "node:child_process";
import { promisify } from "node:util";
const run = promisify(execFile);

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
}
