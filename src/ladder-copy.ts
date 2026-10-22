// Live ladder prose, derived from the bot-owned rank views (web_v1.rank_counts
// plus web_v1.rank_ladder) under the live-data principle: the home heading,
// the stack sentence, the FAQ rungs/entry answers and the About ladder fact
// name the ranks the bot reports, in rank_order — never hard-coded names.
// Plain TypeScript with no imports, so the Kit routes and the Hono screens
// share it exactly like src/home-copy.ts. Callers pass a non-empty ordered
// slice and keep their static bytes for the null-state (empty ranks); these
// helpers never see the fallback path.
export type LadderRank = {
  key: string;
  label: string;
  memberCount: number | null;
};

/** The home ladder heading: the live labels in rank order. */
export function ladderHeading(ranks: LadderRank[]): string {
  return ranks.map((rank) => rank.label).join(" → ");
}

function indefiniteArticle(word: string): "a" | "an" {
  return /^[aeiou]/i.test(word) ? "an" : "a";
}

const COUNT_WORDS = [
  "One",
  "Two",
  "Three",
  "Four",
  "Five",
  "Six",
  "Seven",
  "Eight",
  "Nine",
  "Ten",
  "Eleven",
  "Twelve",
];

function countWord(count: number): string {
  return COUNT_WORDS[count - 1] ?? String(count);
}

// The stack claim names the second-highest rung, the way the static sentence
// named Veteran: the rung a climber stands on while still holding everything
// below. A lone rung cannot stack, so it gets the generic sentence — with no
// rank name, so a one-rung ladder still carries no hard-coded fact.
export function stackSentence(ranks: LadderRank[]): string {
  const holder = ranks.length >= 2 ? ranks[ranks.length - 2]!.label : null;
  if (!holder) return "Ranks stack — every rung holds everything below.";
  return `Ranks stack — ${indefiniteArticle(holder)} ${holder} still holds everything below.`;
}

// The FAQ rungs answer: the derived count, order and stack claim, plus
// "{top} is still unclaimed" if and only if the top rung count is exactly
// zero — an unknown (null) top rung is not unclaimed.
export function rungsAnswer(ranks: LadderRank[]): string {
  const top = ranks[ranks.length - 1]!;
  const unclaimed = top.memberCount === 0 ? ` ${top.label} is still unclaimed.` : "";
  return `${countWord(ranks.length)}, in order: ${ladderHeading(ranks)}. ${stackSentence(ranks)}${unclaimed}`;
}

// The entry answers name the first two live rungs where the static copy named
// Prospect and Member. A lone rung fills both slots: the sentence still names
// only live data, never a hard-coded rank.
function entryRungs(ranks: LadderRank[]): [string, string] {
  const first = ranks[0]!.label;
  return [first, ranks[1]?.label ?? first];
}

/** The FAQ "Is there an application..." answer, derived from the entry rungs. */
export function entryAnswer(ranks: LadderRank[]): string {
  const [first, second] = entryRungs(ranks);
  return (
    `No application, no interview, no tryout. Everyone starts as ${indefiniteArticle(first)} ${first}: ` +
    `show up a few times, play, become ${indefiniteArticle(second)} ${second}. ` +
    "The ladder records trust and time, not grind."
  );
}

/** The About "No application, no interview" fact, derived from the entry rungs. */
export function aboutLadderFact(ranks: LadderRank[]): string {
  const [first, second] = entryRungs(ranks);
  return (
    `You start as ${indefiniteArticle(first)} ${first}. ` +
    `Show up a few times, play, become ${indefiniteArticle(second)} ${second}. ` +
    "The ladder records trust and time, not grind."
  );
}
