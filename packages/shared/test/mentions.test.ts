import { describe, expect, it } from "vitest";
import { type MentionCandidate, encodeMentions, filterCandidates, splitMentions } from "../src/mentions";

const A = "0190a0b0-0000-7000-8000-000000000001";
const R = "0190a0b0-0000-7000-8000-0000000000aa";

const ana: MentionCandidate = { kind: "user", id: A, label: "Ana Paula", hint: "ana", token: `<@${A}>` };
const mod: MentionCandidate = { kind: "role", id: R, label: "Mod", hint: "Cargo", token: `<@&${R}>` };

describe("mentions", () => {
  it("splits users, roles and @everyone/@here", () => {
    expect(splitMentions(`oi <@${A}>, <@&${R}> e @here!`)).toEqual([
      { type: "text", text: "oi " },
      { type: "user", id: A },
      { type: "text", text: ", " },
      { type: "role", id: R },
      { type: "text", text: " e " },
      { type: "everyone", word: "here" },
      { type: "text", text: "!" },
    ]);
    expect(splitMentions("email@here e @everyones")).toEqual([{ type: "text", text: "email@here e @everyones" }]);
  });

  it("encodes readable mentions, longest label first, outside code", () => {
    expect(encodeMentions("oi @Ana Paula e @ana e @Mod", [ana, mod])).toBe(`oi <@${A}> e <@${A}> e <@&${R}>`);
    expect(encodeMentions("`@ana` e ```\n@ana\n``` e @anabela", [ana])).toBe("`@ana` e ```\n@ana\n``` e @anabela");
    expect(encodeMentions("a@ana", [ana])).toBe("a@ana");
  });

  it("filters candidates by prefix of name or username", () => {
    expect(filterCandidates([mod, ana], "pa").map((c) => c.id)).toEqual([A]);
    expect(filterCandidates([mod, ana], "").map((c) => c.id)).toEqual([A, R]);
    expect(filterCandidates([mod, ana], "an").map((c) => c.id)).toEqual([A]);
  });
});
