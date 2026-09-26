import "./_bootstrap.js";
import { reviewTradesJob } from "../jobs.js";
// Usage: npm run review-trades -- [teamId ...]
const ids = process.argv.slice(2).map(Number).filter((n) => !Number.isNaN(n));
console.log(await reviewTradesJob(ids.length ? ids : undefined));
