export type NegotiationStatus = "OPENED" | "COUNTERED" | "AGREED" | "SUBMITTED" | "PROPOSED" | "ACCEPTED" | "REJECTED" | "EXPIRED" | "WALKED";

export interface NegotiationMessage {
  from: "me" | "them";
  text: string;
  at: string;
}

export interface Negotiation {
  id: string;
  otherTeamId: number;
  phone: string;
  status: NegotiationStatus;
  give: number[];
  get: number[];
  rationale: string;
  /** who started the thread; cooldowns only apply to ones I started */
  initiatedBy?: "me" | "them";
  rounds: number;
  thread: NegotiationMessage[];
  espnTradeId?: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}

export interface ActionLog {
  id: string;
  at: string;
  kind: "lineup" | "waiver" | "freeagent" | "trade_proposal" | "trade_response" | "message" | "system";
  summary: string;
  dryRun: boolean;
  payload?: unknown;
}

export interface OutboundMessage {
  id: string;
  phone: string;
  text: string;
  negotiationId?: string;
  createdAt: string;
}

export interface InboundMessage {
  id: string;
  phone: string;
  text: string;
  isFromMe: boolean;
  chatName?: string;
  at: string;
}

export interface Store {
  getState<T>(key: string): Promise<T | undefined>;
  setState<T>(key: string, value: T): Promise<void>;

  putNegotiation(n: Negotiation): Promise<void>;
  getNegotiation(id: string): Promise<Negotiation | undefined>;
  listNegotiations(filter?: { open?: boolean; phone?: string }): Promise<Negotiation[]>;

  logAction(a: Omit<ActionLog, "id" | "at">): Promise<void>;
  listActions(sinceIso: string): Promise<ActionLog[]>;

  enqueueOutbound(m: Omit<OutboundMessage, "id" | "createdAt">): Promise<OutboundMessage>;
  countOutboundToday(phone: string, tz: string): Promise<number>;
  recordInbound(m: InboundMessage): Promise<boolean>;
  listInbound(sinceIso: string): Promise<InboundMessage[]>;
}

export const OPEN_STATUSES: ReadonlySet<NegotiationStatus> = new Set(["OPENED", "COUNTERED", "AGREED", "SUBMITTED", "PROPOSED"]);
/** Threads that still need conversation (a SUBMITTED trade is just waiting on ESPN). */
export const ACTIVE_STATUSES: ReadonlySet<NegotiationStatus> = new Set(["OPENED", "COUNTERED", "AGREED"]);

export function newId(prefix = ""): string {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export function localDay(iso: string, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
}
