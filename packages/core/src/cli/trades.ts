import "./_bootstrap.js";
import { tradeScanJob } from "../jobs.js";
import { LocalStore } from "../store/local.js";
console.log(await tradeScanJob());
if (process.env.STORE !== "dynamo") {
  const out = new LocalStore().drainOutbound();
  if (out.length) console.log("\nWould send:\n" + out.map((m) => `  ${m.phone}: ${m.text}`).join("\n"));
}
