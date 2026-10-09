// Ties the durations in the public privacy policy to the constants and database floors that enforce them.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  JOURNEY_TTL_SECONDS as JOIN_JOURNEY_TTL_SECONDS,
  STATE_TTL_SECONDS as JOIN_STATE_TTL_SECONDS,
} from "../src/join/route";
import { THROTTLE_COUNTER_RETENTION_MINUTES } from "../src/join/service";
import {
  EVENT_SEARCH_LOG_RETENTION_DAYS,
  JOIN_ATTEMPT_RETENTION_DAYS,
  MEMBER_ACCESS_LOG_RETENTION_DAYS,
} from "../src/jobs/constants";
import { OAUTH_JOURNEY_TTL_SECONDS } from "../src/oauth-journeys";
import { MEMBER_STATS_BUDGET_MS } from "../src/profiles/stats";
import { POLICY_FILE, POLICY_VERSION } from "../src/privacy";
import { POLICY_MARKDOWN } from "../src/privacy-content";
import { SESSION_TTL_SECONDS } from "../src/sessions";
import { STATE_TTL_SECONDS as OAUTH_STATE_TTL_SECONDS } from "../src/index";
import { JOURNEY_TTL_SECONDS as RETURN_JOURNEY_TTL_SECONDS } from "../src/return-journey";
import { WRITE_RECOVERY_TTL_SECONDS } from "../src/write-recovery";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const WORDS = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
];
const spell = (n: number): string => WORDS[n] ?? String(n);
const SPOKEN_MS: Record<number, string> = { 500: "half a second" };

type Paragraph = { section: string; text: string };

// Blocks split on blank lines and list-item starts; whitespace collapses so wrapped lines match.
function policyParagraphs(markdown: string): Paragraph[] {
  const paragraphs: Paragraph[] = [];
  let section = "";
  for (const block of markdown.split(/\n\s*\n|\n(?=- )/)) {
    const text = block.replace(/\s+/g, " ").trim();
    if (text.startsWith("## ")) section = text.slice(3);
    else if (text) paragraphs.push({ section, text });
  }
  return paragraphs;
}

const POLICY = policyParagraphs(POLICY_MARKDOWN);

function paragraphNaming(anchor: string): Paragraph {
  const hits = POLICY.filter((p) => p.text.includes(anchor));
  expect(hits, `${POLICY_FILE} needs exactly one paragraph naming "${anchor}"`).toHaveLength(1);
  return hits[0]!;
}

// Whole-word match: "90 days" must not pass on "190 days", nor "five minutes" on "twenty-five minutes".
const mentions = (text: string, phrase: string): boolean =>
  new RegExp(`(?<![\\w-])${phrase}(?![\\w-])`).test(text);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

type Claim = { label: string; anchor: string; phrase: string; pin: string };

const CLAIMS: Claim[] = [
  {
    label: "Join attempts",
    anchor: "Join attempts",
    phrase: `${JOIN_ATTEMPT_RETENTION_DAYS} days`,
    pin: "JOIN_ATTEMPT_RETENTION_DAYS, src/jobs/constants.ts",
  },
  {
    label: "Event searches",
    anchor: "Event searches",
    phrase: `${EVENT_SEARCH_LOG_RETENTION_DAYS} days`,
    pin: "EVENT_SEARCH_LOG_RETENTION_DAYS, src/jobs/constants.ts",
  },
  {
    label: "Access log, who looked",
    anchor: "That access log",
    phrase: `${MEMBER_ACCESS_LOG_RETENTION_DAYS} days`,
    pin: "MEMBER_ACCESS_LOG_RETENTION_DAYS, src/jobs/constants.ts",
  },
  {
    label: "Access log, deletion",
    anchor: "The access log (who looked",
    phrase: `${MEMBER_ACCESS_LOG_RETENTION_DAYS} days`,
    pin: "MEMBER_ACCESS_LOG_RETENTION_DAYS, src/jobs/constants.ts",
  },
  {
    label: "Rate-limit counters",
    anchor: "Rate-limit counters",
    phrase: `${spell(THROTTLE_COUNTER_RETENTION_MINUTES)} minutes`,
    pin: "THROTTLE_COUNTER_RETENTION_MINUTES, src/join/service.ts",
  },
  {
    label: "Activity stats budget",
    anchor: "Activity stats are not stored here",
    phrase: SPOKEN_MS[MEMBER_STATS_BUDGET_MS] ?? `${MEMBER_STATS_BUDGET_MS} milliseconds`,
    pin: "MEMBER_STATS_BUDGET_MS, src/profiles/stats.ts",
  },
  {
    label: "Sign-in session cookie",
    anchor: "`__Host-two_session` keeps you signed in",
    phrase: `${SESSION_TTL_SECONDS / 60} minutes`,
    pin: "SESSION_TTL_SECONDS, src/sessions.ts",
  },
  {
    label: "Sign-in session cookie",
    anchor: "`__Host-two_session` keeps you signed in",
    phrase: `${spell(SESSION_TTL_SECONDS / 3600)} hours`,
    pin: "SESSION_TTL_SECONDS, src/sessions.ts",
  },
  {
    label: "Journey cookies",
    anchor: "`__Host-two_oauth_state`",
    phrase: `at most ${OAUTH_STATE_TTL_SECONDS / 60} minutes`,
    pin: "STATE_TTL_SECONDS, src/index.tsx",
  },
  {
    label: "Journey cookies",
    anchor: "`__Host-two_oauth_state`",
    phrase: `at most ${OAUTH_JOURNEY_TTL_SECONDS / 60} minutes`,
    pin: "OAUTH_JOURNEY_TTL_SECONDS, src/oauth-journeys.ts",
  },
  {
    label: "Journey cookies",
    anchor: "`__Host-two_oauth_state`",
    phrase: `at most ${JOIN_STATE_TTL_SECONDS / 60} minutes`,
    pin: "STATE_TTL_SECONDS, src/join/route.ts",
  },
  {
    label: "Journey cookies",
    anchor: "`__Host-two_oauth_state`",
    phrase: `at most ${JOIN_JOURNEY_TTL_SECONDS / 60} minutes`,
    pin: "JOURNEY_TTL_SECONDS, src/join/route.ts",
  },
  {
    label: "Journey cookies",
    anchor: "`__Host-two_oauth_state`",
    phrase: `at most ${RETURN_JOURNEY_TTL_SECONDS / 60} minutes`,
    pin: "JOURNEY_TTL_SECONDS, src/return-journey.ts",
  },
  {
    label: "Journey cookies",
    anchor: "`__Host-two_oauth_state`",
    phrase: `at most ${WRITE_RECOVERY_TTL_SECONDS / 60} minutes`,
    pin: "WRITE_RECOVERY_TTL_SECONDS, src/write-recovery.tsx",
  },
];

// Bot-owned: the transcripts live in Discord and the support bot deletes them, outside this repository.
const OUT_OF_SCOPE = [
  {
    anchor: "Support-ticket transcripts are the one narrow exception",
    claim: "kept for 90 days",
    reason: "bot-owned, retention runs in Discord",
  },
  {
    anchor: "Private support-ticket transcripts live in Discord",
    claim: "kept for 90 days",
    reason: "bot-owned, retention runs in Discord",
  },
];

const UNIT = /\b(?:seconds?|minutes?|hours?|days?|weeks?|months?|years?)\b/i;

// The append-only trigger refuses to delete an audit row younger than its floor, so a retention
// shorter than the floor would not hold. Each source must sit at or under the policy's days.
const ACCESS_LOG_FLOORS: [file: string, floor: RegExp][] = [
  ["src/jobs/postgres.ts", /const accessLog[\s\S]*?interval '(\d+) hours'/],
  [
    "drizzle/1018_audit-immutability.sql",
    /"audit_rows_append_only"\(\)[\s\S]*?interval '(\d+) hours'/,
  ],
];

// Every cookie lifetime in src must be one of these; each is pinned by a CLAIMS row above.
const PINNED_COOKIE_LIFETIMES = [
  "SESSION_TTL_SECONDS",
  "STATE_TTL_SECONDS",
  "JOURNEY_TTL_SECONDS",
  "WRITE_RECOVERY_TTL_SECONDS",
];

describe(`privacy policy v${POLICY_VERSION} numbers are pinned to code`, () => {
  it.each(CLAIMS)('$label states "$phrase" (pinned: $pin)', ({ label, anchor, phrase, pin }) => {
    const paragraph = paragraphNaming(anchor);
    expect(
      paragraph.text,
      `${POLICY_FILE} "${paragraph.section}" paragraph "${label}" must state "${phrase}" (${pin}). ` +
        "Change the policy only as a new numbered version.",
    ).toContain(phrase);
  });

  it.each(OUT_OF_SCOPE)(
    'lists "$claim" as out of scope ($reason): $anchor',
    ({ anchor, claim }) => {
      expect(paragraphNaming(anchor).text).toContain(claim);
    },
  );

  it("accounts for every sentence that states a duration: pinned or out of scope", () => {
    const phrasesByParagraph = new Map<string, string[]>();
    const pinParagraph = (anchor: string, phrase: string) => {
      const { text } = paragraphNaming(anchor);
      phrasesByParagraph.set(text, [...(phrasesByParagraph.get(text) ?? []), phrase]);
    };
    for (const { anchor, phrase } of CLAIMS) pinParagraph(anchor, phrase);
    for (const { anchor, claim } of OUT_OF_SCOPE) pinParagraph(anchor, claim);
    const unaccounted = POLICY.flatMap(({ text }) =>
      text
        .split(/(?<=[.!?])\s+/)
        .filter((sentence) => UNIT.test(sentence))
        .filter(
          (sentence) =>
            !(phrasesByParagraph.get(text) ?? []).some((phrase) => mentions(sentence, phrase)),
        )
        .map((sentence) => sentence.slice(0, 90)),
    );
    expect(unaccounted, `${POLICY_FILE} states a duration that no test pins`).toEqual([]);
  });

  it.each(ACCESS_LOG_FLOORS)(
    "keeps the access-log floor in %s within the policy",
    (file, floor) => {
      const hours = Number(readFileSync(resolve(root, file), "utf8").match(floor)?.[1]);
      expect(hours, `${file} must declare its access-log floor in hours`).toBeGreaterThan(0);
      expect(
        hours,
        `${file} refuses to delete access-log rows younger than ${hours} hours, longer than the ${MEMBER_ACCESS_LOG_RETENTION_DAYS}-day retention the policy states`,
      ).toBeLessThanOrEqual(MEMBER_ACCESS_LOG_RETENTION_DAYS * 24);
    },
  );

  it("gives every cookie lifetime in src a pinned constant", () => {
    const offenders = sourceFiles(resolve(root, "src")).flatMap((file) => {
      const text = readFileSync(file, "utf8");
      const where = relative(root, file);
      const lifetimes = [...text.matchAll(/maxAge:\s*([^,}\n]+)/g)].map((match) =>
        match[1]!.trim(),
      );
      return [
        ...lifetimes
          .filter((expr) => !PINNED_COOKIE_LIFETIMES.includes(expr))
          .map((expr) => `${where}: maxAge: ${expr}`),
        ...(/Max-Age=|\bexpires:/.test(text) ? [`${where}: raw cookie expiry`] : []),
      ];
    });
    expect(offenders, "every cookie lifetime in src must be one of the pinned constants").toEqual(
      [],
    );
  });
});
