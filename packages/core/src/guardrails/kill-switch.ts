import type { Store } from "../store/types.js";

const KEY = "paused";

export async function isPaused(s: Store): Promise<boolean> {
  return (await s.getState<boolean>(KEY)) === true;
}

export async function setPaused(s: Store, paused: boolean): Promise<void> {
  await s.setState(KEY, paused);
  await s.logAction({ kind: "system", summary: paused ? "PAUSED by kill switch" : "RESUMED", dryRun: false });
}

/** Texting yourself "STOP" pauses everything; "GO" resumes. Returns true if handled. */
export async function handleControlMessage(s: Store, text: string): Promise<"paused" | "resumed" | undefined> {
  const t = text.trim().toUpperCase();
  if (t === "STOP") { await setPaused(s, true); return "paused"; }
  if (t === "GO") { await setPaused(s, false); return "resumed"; }
  return undefined;
}
