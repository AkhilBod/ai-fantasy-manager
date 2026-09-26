import { describe, expect, it } from "vitest";
import { appleToIso, decodeAttributedBody, normalizePhone } from "../src/chatdb.js";

describe("chatdb helpers", () => {
  it("normalizes phone handles", () => {
    expect(normalizePhone("(555) 555-0100")).toBe("+15555550100");
    expect(normalizePhone("+1 555 555 0100")).toBe("+15555550100");
    expect(normalizePhone("15555550100")).toBe("+15555550100");
    expect(normalizePhone("Bob@Example.com")).toBe("bob@example.com");
  });
  it("converts Apple nanosecond timestamps", () => {
    expect(appleToIso(0)).toBe("2001-01-01T00:00:00.000Z");
    expect(appleToIso(1e9 * 86400)).toBe("2001-01-02T00:00:00.000Z");
  });
  it("decodes a typedstream NSString payload", () => {
    const text = "sup bro";
    const buf = Buffer.concat([Buffer.from("junk\x84\x84\x84"), Buffer.from("NSString"), Buffer.from([1, 0x94, 0x84, 1, 0x2b]), Buffer.from([text.length]), Buffer.from(text), Buffer.from([0x86])]);
    expect(decodeAttributedBody(buf)).toBe(text);
    expect(decodeAttributedBody(null)).toBe("");
  });
});
