import { describe, expect, it, vi } from "vitest";

vi.mock("../src/brain/llm.js", () => ({
  llm: () => ({ messages: { parse: async () => ({ stop_reason: "end_turn", parsed_output: { score: 9, tells: [], clear: true } }) } }),
  modelId: () => "test",
  assertNotRefused: () => {},
  textOf: () => "",
}));

import { checkDraft, bannedIn } from "../src/voice/check.js";
import { pickFewShots, inventedPlayers } from "../src/voice/draft.js";
import type { VoiceBundle } from "../src/voice/types.js";

const bundle: VoiceBundle = {
  builtAt: "", sourceMessageCount: 10,
  profile: { summary: "lowercase texter", casing: "lowercase", punctuation: "none", lengthWords: { median: 8, p90: 20 }, emoji: { frequency: "never", favorites: [] }, lexicon: ["bro", "lowkey"], avoid: ["Hey!"], openers: [], closers: [], footballTalk: "", negotiationStyle: "chill" },
  fewshots: [{ intent: "propose", text: "yo u want cmc" }, { intent: "banter", text: "lmao no" }, { intent: "propose", text: "ill do it for kelce" }],
};

describe("checkDraft hard rules", () => {
  it("rejects long / capitalized / AI-mentioning / emoji drafts before calling the judge", async () => {
    expect((await checkDraft(bundle, "Hey! Would you be interested in a trade?")).feedback).toMatch(/capital/);
    expect((await checkDraft(bundle, "as an AI i think")).feedback).toMatch(/AI/);
    expect((await checkDraft(bundle, "lmaooo nah thats me bru")).feedback).toMatch(/human/);
    expect((await checkDraft(bundle, "just hit accept on espn")).feedback).toMatch(/pesters/);
    expect((await checkDraft(bundle, "yo 🔥")).feedback).toMatch(/emoji/);
    expect((await checkDraft(bundle, Array(40).fill("word").join(" "))).feedback).toMatch(/too long/);
    expect((await checkDraft(bundle, "a — b")).feedback).toMatch(/em dash/);
  });
  it("passes a good draft through the judge", async () => {
    const r = await checkDraft(bundle, "yo u want kelce for ur rb2");
    expect(r.pass).toBe(true);
    expect(r.score).toBe(9);
  });
});

describe("banned words + length", () => {
  it("catches banned words on word boundaries only", () => {
    expect(bannedIn("yo nga wassup", ["nga"])).toEqual(["nga"]);
    expect(bannedIn("Nga u around", ["nga"])).toEqual(["nga"]);
    expect(bannedIn("that was mangalicious", ["nga"])).toEqual([]);
  });
  it("rejects multi-line essays", async () => {
    const r = await checkDraft(bundle, "line one\nline two\nline three");
    expect(r.feedback).toMatch(/too many lines/);
  });
});

describe("inventedPlayers", () => {
  it("flags league players that aren't on either roster or in the terms", () => {
    const known = { all: new Set(["kupp", "waddle", "pollard", "flowers", "lamb"]), allowed: new Set(["flowers", "lamb"]) };
    expect(inventedPlayers("I got Kupp Waddle Pollard Zay Flowers who u want", known)).toEqual(["kupp", "waddle", "pollard"]);
    expect(inventedPlayers("zay flowers for lamb?", known)).toEqual([]);
  });
});

describe("pickFewShots", () => {
  it("prefers same-intent examples", () => {
    const s = pickFewShots(bundle, "propose", 2);
    expect(s.map((x) => x.intent)).toEqual(["propose", "propose"]);
  });
});
