import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { repoRoot } from "../config.js";
import { OPEN_STATUSES, localDay, newId, type ActionLog, type InboundMessage, type Negotiation, type OutboundMessage, type Store } from "./types.js";

interface Db {
  state: Record<string, unknown>;
  negotiations: Record<string, Negotiation>;
  actions: ActionLog[];
  outbound: OutboundMessage[];
  inboundIds: string[];
  inbound?: InboundMessage[];
}

/** JSON-file store for local dry runs and tests. */
export class LocalStore implements Store {
  private db: Db;
  constructor(private readonly path = resolve(repoRoot, "data/store.json")) {
    this.db = existsSync(path)
      ? JSON.parse(readFileSync(path, "utf8"))
      : { state: {}, negotiations: {}, actions: [], outbound: [], inboundIds: [] };
  }
  private save() {
    mkdirSync(resolve(this.path, ".."), { recursive: true });
    writeFileSync(this.path, JSON.stringify(this.db, null, 2));
  }
  async getState<T>(key: string) { return this.db.state[key] as T | undefined; }
  async setState<T>(key: string, value: T) { this.db.state[key] = value; this.save(); }
  async putNegotiation(n: Negotiation) { this.db.negotiations[n.id] = n; this.save(); }
  async getNegotiation(id: string) { return this.db.negotiations[id]; }
  async listNegotiations(filter: { open?: boolean; phone?: string } = {}) {
    return Object.values(this.db.negotiations).filter((n) =>
      (filter.open == null || OPEN_STATUSES.has(n.status) === filter.open) && (filter.phone == null || n.phone === filter.phone));
  }
  async logAction(a: Omit<ActionLog, "id" | "at">) {
    this.db.actions.push({ ...a, id: newId("a_"), at: new Date().toISOString() });
    this.save();
  }
  async listActions(sinceIso: string) { return this.db.actions.filter((a) => a.at >= sinceIso); }
  async enqueueOutbound(m: Omit<OutboundMessage, "id" | "createdAt">) {
    const full: OutboundMessage = { ...m, id: newId("m_"), createdAt: new Date().toISOString() };
    this.db.outbound.push(full);
    this.save();
    return full;
  }
  async countOutboundToday(phone: string, tz: string) {
    const today = localDay(new Date().toISOString(), tz);
    return this.db.outbound.filter((m) => m.phone === phone && localDay(m.createdAt, tz) === today).length;
  }
  async recordInbound(m: InboundMessage) {
    if (this.db.inboundIds.includes(m.id)) return false;
    this.db.inboundIds.push(m.id);
    (this.db.inbound ??= []).push(m);
    this.save();
    return true;
  }
  async listInbound(sinceIso: string) { return (this.db.inbound ?? []).filter((m) => m.at >= sinceIso); }
  /** test/CLI helper */
  drainOutbound(): OutboundMessage[] { const o = this.db.outbound; this.db.outbound = []; this.save(); return o; }
}
