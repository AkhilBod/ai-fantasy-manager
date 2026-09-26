import { env } from "../config.js";
import { DynamoStore } from "./dynamo.js";
import { LocalStore } from "./local.js";
import type { Store } from "./types.js";

export * from "./types.js";
export { LocalStore, DynamoStore };

let cached: Store | undefined;
export function store(): Store {
  if (!cached) cached = env.store === "dynamo" ? new DynamoStore() : new LocalStore();
  return cached;
}
