import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import { resolve } from "node:path";

export const CHAT_DB = resolve(homedir(), "Library/Messages/chat.db");

export interface ChatRow {
  rowid: number;
  guid: string;
  text: string;
  isFromMe: boolean;
  handle: string;
  chatName: string | null;
  chatGuid: string | null;
  date: string;
}

/** Apple stores nanoseconds since 2001-01-01. */
export function appleToIso(n: number): string {
  const secs = n > 1e12 ? n / 1e9 : n;
  return new Date((secs + 978307200) * 1000).toISOString();
}

/**
 * macOS 13+ often leaves `text` NULL and stores the body in `attributedBody`
 * (an NSAttributedString typedstream). Pull the first NSString payload out.
 */
export function decodeAttributedBody(buf: Uint8Array | null): string {
  if (!buf) return "";
  const s = Buffer.from(buf);
  const marker = s.indexOf("NSString");
  if (marker < 0) return "";
  // After "NSString" + 5 bytes of typedstream header comes a length-prefixed string.
  let i = marker + 8 + 5;
  if (i >= s.length) return "";
  let len = s[i];
  i += 1;
  if (len === 0x81) { len = s.readUInt16LE(i); i += 2; }
  else if (len === 0x82) { len = s.readUInt32LE(i); i += 4; }
  return s.subarray(i, i + len).toString("utf8").replace(/￼/g, "").trim();
}

export function openChatDb(path = CHAT_DB): DatabaseSync {
  try {
    return new DatabaseSync(path, { readOnly: true });
  } catch (e) {
    throw new Error(`cannot open ${path}. Grant Full Disk Access to your terminal/node in System Settings → Privacy & Security → Full Disk Access. (${(e as Error).message})`);
  }
}

const SELECT = `
  SELECT m.ROWID as rowid, m.guid, m.text, m.attributedBody, m.is_from_me, (m.date / 1000000000) as date,
         h.id as handle, c.display_name as chat_name, c.guid as chat_guid
  FROM message m
  LEFT JOIN handle h ON h.ROWID = m.handle_id
  LEFT JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
  LEFT JOIN chat c ON c.ROWID = cmj.chat_id
`;

function rowToChat(r: any): ChatRow {
  const text = (r.text as string | null) ?? decodeAttributedBody(r.attributedBody);
  return {
    rowid: Number(r.rowid), guid: r.guid, text, isFromMe: Number(r.is_from_me) === 1,
    handle: r.handle ?? "", chatName: r.chat_name || null, chatGuid: r.chat_guid ?? null, date: appleToIso(Number(r.date)),
  };
}

/** node:sqlite throws on int64 values outside the safe range unless we read BigInts. */
function bigSafe(db: DatabaseSync, sql: string) {
  const stmt = db.prepare(sql);
  stmt.setReadBigInts(true);
  return stmt;
}

export function messagesAfter(db: DatabaseSync, rowid: number, limit = 200): ChatRow[] {
  const rows = bigSafe(db, `${SELECT} WHERE m.ROWID > ? AND m.item_type = 0 ORDER BY m.ROWID ASC LIMIT ?`).all(rowid, limit);
  return rows.map(rowToChat).filter((r) => r.text.length > 0);
}

export function maxRowid(db: DatabaseSync): number {
  const r = bigSafe(db, "SELECT MAX(ROWID) as m FROM message").get() as { m: bigint | null };
  return Number(r.m ?? 0);
}

export function myMessages(db: DatabaseSync, limit = 20000): ChatRow[] {
  const rows = bigSafe(db, `${SELECT} WHERE m.is_from_me = 1 AND m.item_type = 0 ORDER BY m.date DESC LIMIT ?`).all(limit);
  return rows.map(rowToChat).filter((r) => r.text.length > 0);
}

export function normalizePhone(handle: string): string {
  const digits = handle.replace(/[^\d+]/g, "");
  if (handle.includes("@")) return handle.toLowerCase();
  if (digits.startsWith("+")) return digits;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return digits;
}
