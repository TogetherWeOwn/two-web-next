// Unit pins for the live ladder prose (src/ladder-copy.ts): the derivation
// rules the web_v1 acceptance suite (test/web-v1-rank-live-acceptance.test.ts)
// pins end to end, nailed down at the seam for edge shapes the integration
// suite does not cover (single rung, article choice, count words).
import { describe, expect, it } from "vitest";
import { faqPageData } from "../src/faq-content";
import {
  aboutLadderFact,
  entryAnswer,
  ladderHeading,
  rungsAnswer,
  stackSentence,
  type LadderRank,
} from "../src/ladder-copy";

const LIVE: LadderRank[] = [
  { key: "ember", label: "Ember", memberCount: 24 },
  { key: "tide", label: "Tide", memberCount: 40 },
  { key: "stone", label: "Stone", memberCount: 0 },
  { key: "thorn", label: "Thorn", memberCount: null },
  { key: "crown", label: "Crown", memberCount: 3 },
];

describe("faqPageData", () => {
  it("retains the RSVP recovery link when deriving live ladder answers", () => {
    const { faqs } = faqPageData("https://example.test", [LIVE[0]!, LIVE[4]!]);
    const events = faqs.find((group) => group.sectionId === "faq-events");
    const recovery = events?.items.find(([question]) =>
      question.includes("What if my RSVP is syncing"),
    );
    expect(recovery?.[2]).toEqual({
      label: "RSVP recovery guide",
      href: "https://github.com/TogetherWeOwn/two-web-next/blob/main/docs/rsvp-recovery.md",
    });
    const ranks = faqs.find((group) => group.sectionId === "faq-ranks");
    expect(
      ranks?.items.find(([question]) => question === "What are the rank rungs?")?.[1],
    ).toContain("Ember → Crown");
  });
});

describe("ladderHeading", () => {
  it("joins the live labels in rank order", () => {
    expect(ladderHeading(LIVE)).toBe("Ember → Tide → Stone → Thorn → Crown");
  });
});

describe("stackSentence", () => {
  it("names the second-highest rung with the matching article", () => {
    expect(stackSentence(LIVE)).toBe("Ranks stack — a Thorn still holds everything below.");
  });

  it("uses 'an' before a vowel-led rung", () => {
    const ranks: LadderRank[] = [
      { key: "tide", label: "Tide", memberCount: 1 },
      { key: "ember", label: "Ember", memberCount: 2 },
    ];
    expect(stackSentence(ranks)).toBe("Ranks stack — a Tide still holds everything below.");
    expect(stackSentence([...ranks].reverse())).toBe(
      "Ranks stack — an Ember still holds everything below.",
    );
  });

  it("stays rank-name-free for a single rung", () => {
    const sentence = stackSentence([LIVE[0]!]);
    expect(sentence).toContain("Ranks stack");
    expect(sentence).not.toContain("Ember");
  });
});

describe("rungsAnswer", () => {
  it("derives the count word, order and stack claim", () => {
    expect(rungsAnswer(LIVE)).toBe(
      "Five, in order: Ember → Tide → Stone → Thorn → Crown. " +
        "Ranks stack — a Thorn still holds everything below.",
    );
  });

  it("derives a smaller ladder without the five-rung claim", () => {
    const ranks = [LIVE[0]!, LIVE[2]!, { ...LIVE[4]!, memberCount: 0 }];
    expect(rungsAnswer(ranks)).toBe(
      "Three, in order: Ember → Stone → Crown. " +
        "Ranks stack — a Stone still holds everything below. Crown is still unclaimed.",
    );
  });

  it("claims unclaimed if and only if the top rung count is exactly zero", () => {
    expect(rungsAnswer(LIVE)).not.toContain("still unclaimed");
    const zeroTop = LIVE.map((rank) => (rank.key === "crown" ? { ...rank, memberCount: 0 } : rank));
    expect(rungsAnswer(zeroTop)).toContain("Crown is still unclaimed");
    const unknownTop = LIVE.map((rank) =>
      rank.key === "crown" ? { ...rank, memberCount: null } : rank,
    );
    expect(rungsAnswer(unknownTop)).not.toContain("still unclaimed");
  });
});

describe("entryAnswer", () => {
  it("names the live entry rungs with matching articles", () => {
    expect(entryAnswer(LIVE)).toBe(
      "No application, no interview, no tryout. Everyone starts as an Ember: " +
        "show up a few times, play, become a Tide. The ladder records trust and time, not grind.",
    );
  });
});

describe("aboutLadderFact", () => {
  it("names the live entry rungs with matching articles", () => {
    expect(aboutLadderFact(LIVE)).toBe(
      "You start as an Ember. Show up a few times, play, become a Tide. " +
        "The ladder records trust and time, not grind.",
    );
  });
});
