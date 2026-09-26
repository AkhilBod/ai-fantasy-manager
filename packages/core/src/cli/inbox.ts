import "./_bootstrap.js";
import { inboxJob } from "../jobs.js";
console.log(await inboxJob(Number(process.argv[2] ?? 48)));
