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
  BOARD_VIEW_LOG_RETENTION_DAYS,
  EVENT_SEARCH_LOG_RETENTION_DAYS,
  JOIN_ATTEMPT_RETENTION_DAYS,
  MEMBER_ACCESS_LOG_RETENTION_DAYS,
} from "../src/jobs/constants";
import { OAUTH_JOURNEY_TTL_SECONDS } from "../src/oauth-journeys";
import { MEMBER_STATS_BUDGET_MS } from "../src/profiles/stats";
import { POLICY_FILE, POLICY_VERSION } from "../src/privacy";
import { POLICY_MARKDOWN } from "../src/privacy-content";
import { SESSION_ABSOLUTE_MAX_AGE_SECONDS, SESSION_TTL_SECONDS } from "../src/sessions";
import { STATE_TTL_SECONDS as OAUTH_STATE_TTL_SECONDS } from "../src/index";
import { JOURNEY_TTL_SECONDS as RETURN_JOURNEY_TTL_SECONDS } from "../src/return-journey";
import { WRITE_RECOVERY_TTL_SECONDS } from "../src/write-recovery";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (file: string): string => readFileSync(resolve(root, file), "utf8");

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

const UNIT =
  /(?<![\w-])(?:milliseconds?|seconds?|minutes?|hours?|days?|weeks?|months?|years?|ms)(?![\w-])/i;
const DURATION =
  /(?<![\w-])(?:\d+(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|twenty|thirty|forty|fifty|sixty|ninety|half a|a)[ -](?:milliseconds?|seconds?|minutes?|hours?|days?|weeks?|months?|years?|ms)(?![\w-])/gi;

const durationsOf = (text: string): string[] => text.toLowerCase().match(DURATION) ?? [];

// Exact token match: "120 minutes" must not account for "20 minutes",
// nor "half a second" for "a second".
function unaccountedSentences(paragraphText: string, pinnedPhrases: string[]): string[] {
  const pinned = new Set(pinnedPhrases.flatMap(durationsOf));
  return paragraphText
    .split(/(?<=[.!?])\s+/)
    .filter((sentence) => UNIT.test(sentence))
    .filter((sentence) => {
      const durations = durationsOf(sentence);
      return durations.length === 0 || durations.some((duration) => !pinned.has(duration));
    });
}

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
    label: "Leaderboard views",
    anchor: "Leaderboard views",
    phrase: `${BOARD_VIEW_LOG_RETENTION_DAYS} days`,
    pin: "BOARD_VIEW_LOG_RETENTION_DAYS, src/jobs/constants.ts",
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
    label: "Absolute session age cap",
    anchor: "`__Host-two_session` keeps you signed in",
    phrase: `${SESSION_ABSOLUTE_MAX_AGE_SECONDS / 3600} hours`,
    pin: "SESSION_ABSOLUTE_MAX_AGE_SECONDS, src/sessions.ts",
  },
  {
    label: "Absolute cap changelog",
    anchor: "Version 6 caps every sign-in",
    phrase: `${SESSION_ABSOLUTE_MAX_AGE_SECONDS / 3600} hours`,
    pin: "SESSION_ABSOLUTE_MAX_AGE_SECONDS, src/sessions.ts",
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

// Every cookie lifetime in src must be one of these; each is pinned by a CLAIMS row above.
const PINNED_COOKIE_LIFETIMES = [
  "SESSION_TTL_SECONDS",
  "STATE_TTL_SECONDS",
  "JOURNEY_TTL_SECONDS",
  "WRITE_RECOVERY_TTL_SECONDS",
];

// Each call to a cookie writer, from its name to its closing parenthesis.
function cookieCalls(text: string): string[] {
  return [
    ...text.matchAll(/\b(?:setSignedCookie|generateSignedCookie|setCookie|generateCookie)\(/g),
  ].map((call) => {
    const start = call.index ?? 0;
    let depth = 0;
    let end = start + call[0].length - 1;
    for (; end < text.length; end++) {
      if (text[end] === "(") depth++;
      else if (text[end] === ")" && --depth === 0) break;
    }
    return text.slice(start, end + 1);
  });
}

// The only modules that may define each lifetime; every other file must import
// it from one of these under the same name. The join TTLs live in the shared
// route leaf; the barrel re-exports them so the historic import path still
// resolves.
const PINNED_COOKIE_ORIGINS: Record<string, string[]> = {
  SESSION_TTL_SECONDS: ["src/sessions.ts"],
  STATE_TTL_SECONDS: ["src/index.tsx", "src/join/route.ts", "src/join/route-shared.ts"],
  JOURNEY_TTL_SECONDS: ["src/join/route.ts", "src/join/route-shared.ts", "src/return-journey.ts"],
  WRITE_RECOVERY_TTL_SECONDS: ["src/write-recovery.tsx"],
};

type ImportEntry = { local: string; imported: string; source: string };

function importEntries(text: string): ImportEntry[] {
  const entries: ImportEntry[] = [];
  for (const statement of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/g)) {
    for (const part of statement[1]!.split(",")) {
      const specifier = part.trim();
      if (!specifier || specifier.startsWith("type ")) continue;
      const alias = /^(\w+)\s+as\s+(\w+)$/.exec(specifier);
      if (alias) entries.push({ imported: alias[1]!, local: alias[2]!, source: statement[2]! });
      else if (/^\w+$/.test(specifier))
        entries.push({ imported: specifier, local: specifier, source: statement[2]! });
    }
  }
  return entries;
}

// A pinned name counts only from its canonical module: defined there, or imported
// from there under the same name. A same-named local constant anywhere else is a
// shadow, not the pin.
function pinnedLifetimeInFile(where: string, fileText: string, snippet: string): boolean {
  const name = snippet.match(/maxAge:\s*(\w+)/)?.[1];
  if (name === undefined || !PINNED_COOKIE_LIFETIMES.includes(name)) return false;
  const origins = PINNED_COOKIE_ORIGINS[name] ?? [];
  if (origins.includes(where))
    return new RegExp(`export\\s+(?:const|let|var)\\s+${name}\\b`).test(fileText);
  return importEntries(fileText).some(
    (entry) =>
      entry.local === name &&
      entry.imported === name &&
      entry.source.startsWith(".") &&
      origins.some((origin) => {
        const base = join(dirname(where), entry.source);
        return origin === base || origin.startsWith(`${base}.`);
      }),
  );
}

// A call passes when its options carry a pinned maxAge, inline or through a same-file options constant.
function unpinnedCookieCalls(file: string, text: string): string[] {
  const where = relative(root, file);
  return cookieCalls(text).flatMap((call) => {
    if (pinnedLifetimeInFile(where, text, call)) return [];
    const lastArg = call.slice(0, -1).split(",").at(-1)?.trim() ?? "";
    if (/^\w+$/.test(lastArg)) {
      const definition = new RegExp(`const ${lastArg} = \\{[\\s\\S]*?\\};`).exec(text)?.[0] ?? "";
      if (pinnedLifetimeInFile(where, text, definition)) return [];
    }
    return [`${where}: ${call.replace(/\s+/g, " ").slice(0, 80)}`];
  });
}

// An empty unsigned cookie with a literal zero expiry deletes state, not a
// live lifetime. Recognize only this simple form: no nested calls, duplicate
// expiry, or trailing spread that could override the zero.
function withoutCookieDeletions(text: string): string {
  if (
    !importEntries(text).some(
      (entry) =>
        entry.local === "generateCookie" &&
        entry.imported === "generateCookie" &&
        entry.source === "hono/cookie",
    )
  )
    return text;
  return text.replace(
    /\bgenerateCookie\(\s*\w+\s*,\s*(?:""|'')\s*,\s*\{\s*(?:\.\.\.\w+\s*,\s*)?maxAge:\s*0\s*,?\s*\}\s*\)/g,
    "",
  );
}

function cookieLifetimeOffenders(file: string, text: string): string[] {
  text = withoutCookieDeletions(text);
  const where = relative(root, file);
  const expressions = [...text.matchAll(/maxAge:\s*([^,}\n]+)/g)].map((match) => match[1]!.trim());
  return [
    ...expressions.flatMap((expr) => {
      if (!PINNED_COOKIE_LIFETIMES.includes(expr)) return [`${where}: maxAge: ${expr}`];
      if (!pinnedLifetimeInFile(where, text, `maxAge: ${expr}`))
        return [
          `${where}: maxAge: ${expr} must come from its pinned module (${(PINNED_COOKIE_ORIGINS[expr] ?? []).join(" or ")})`,
        ];
      return [];
    }),
    ...(/\bmaxAge\s*[,}]/.test(text) ? [`${where}: shorthand maxAge`] : []),
    ...(/\b(?:Max-Age|Expires)=/.test(text) ? [`${where}: raw cookie expiry`] : []),
    ...unpinnedCookieCalls(file, text),
  ];
}

describe(`privacy policy v${POLICY_VERSION} numbers are pinned to code`, () => {
  it.each(CLAIMS)('$label states "$phrase" (pinned: $pin)', ({ label, anchor, phrase, pin }) => {
    const paragraph = paragraphNaming(anchor);
    expect(
      mentions(paragraph.text, phrase),
      `${POLICY_FILE} "${paragraph.section}" paragraph "${label}" must state "${phrase}" as a whole phrase (${pin}). ` +
        "Change the policy only as a new numbered version.",
    ).toBe(true);
  });

  it.each(OUT_OF_SCOPE)(
    'lists "$claim" as out of scope ($reason): $anchor',
    ({ anchor, claim }) => {
      expect(mentions(paragraphNaming(anchor).text, claim)).toBe(true);
    },
  );

  it("accounts for every duration sentence in the policy: pinned or out of scope", () => {
    const phrasesByParagraph = new Map<string, string[]>();
    const pinParagraph = (anchor: string, phrase: string) => {
      const { text } = paragraphNaming(anchor);
      phrasesByParagraph.set(text, [...(phrasesByParagraph.get(text) ?? []), phrase]);
    };
    for (const { anchor, phrase } of CLAIMS) pinParagraph(anchor, phrase);
    for (const { anchor, claim } of OUT_OF_SCOPE) pinParagraph(anchor, claim);
    const unaccounted = POLICY.flatMap(({ text }) =>
      unaccountedSentences(text, phrasesByParagraph.get(text) ?? []).map((sentence) =>
        sentence.slice(0, 90),
      ),
    );
    expect(unaccounted, `${POLICY_FILE} states a duration that no test pins`).toEqual([]);
  });

  it("does not let a pinned phrase cover a shorter overlapping duration", () => {
    expect(
      unaccountedSentences("Sessions last 120 minutes. Idle seats free after 20 minutes.", [
        "120 minutes",
      ]),
    ).not.toEqual([]);
    expect(
      unaccountedSentences("Stats finish in half a second. Snapshots take a second.", [
        "half a second",
      ]),
    ).not.toEqual([]);
    expect(unaccountedSentences("Sessions last 120 minutes.", ["120 minutes"])).toEqual([]);
  });

  it("keeps the access-log prune floor equal to the retention", () => {
    const floor = Number(
      read("src/jobs/postgres.ts").match(/const accessLog[\s\S]*?interval '(\d+) hours'/)?.[1],
    );
    expect(
      floor,
      `src/jobs/postgres.ts access-log floor must equal ${MEMBER_ACCESS_LOG_RETENTION_DAYS} days; a different floor needs a migration and a policy change`,
    ).toBe(MEMBER_ACCESS_LOG_RETENTION_DAYS * 24);
  });

  it("keeps the audit trigger floor equal to the retention", () => {
    const floors = readdirSync(resolve(root, "drizzle"))
      .filter((file) => file.endsWith(".sql"))
      .sort()
      .flatMap((file) => {
        const match = read(`drizzle/${file}`).match(
          /CREATE (?:OR REPLACE )?FUNCTION "public"\."audit_rows_append_only"\(\)[\s\S]*?interval '(\d+) hours'/,
        );
        return match ? [Number(match[1])] : [];
      });
    expect(
      floors.at(-1),
      `the latest audit_rows_append_only definition must keep access-log rows ${MEMBER_ACCESS_LOG_RETENTION_DAYS} days`,
    ).toBe(MEMBER_ACCESS_LOG_RETENTION_DAYS * 24);
  });

  it("gives every cookie lifetime in src a pinned constant", () => {
    const offenders = sourceFiles(resolve(root, "src")).flatMap((file) =>
      cookieLifetimeOffenders(file, readFileSync(file, "utf8")),
    );
    expect(offenders, "every cookie lifetime in src must be one of the pinned constants").toEqual(
      [],
    );
  });

  it("recognizes an explicit empty-cookie deletion rather than a live lifetime", () => {
    const source = [
      'import { generateCookie } from "hono/cookie";',
      'generateCookie(LOGIN_INTENDED_COOKIE, "", { ...options, maxAge: 0 });',
    ].join("\n");
    expect(cookieLifetimeOffenders(resolve(root, "src/example.ts"), source)).toEqual([]);
  });

  it.each([
    { label: "no import", declaration: "" },
    {
      label: "a local-module writer",
      declaration: 'import { generateCookie } from "./cookie";',
    },
    {
      label: "a different local binding",
      declaration: 'import { generateCookie as otherCookie } from "hono/cookie";',
    },
    {
      label: "a different imported writer",
      declaration: 'import { generateSignedCookie as generateCookie } from "hono/cookie";',
    },
  ])("rejects a deletion-shaped call with $label", ({ declaration }) => {
    const source = `${declaration}\ngenerateCookie(name, "", { maxAge: 0 });`;
    expect(cookieLifetimeOffenders(resolve(root, "src/example.ts"), source).length).toBeGreaterThan(
      0,
    );
  });

  it.each([
    'generateCookie(name, "live", { maxAge: 0 });',
    'generateCookie(name, "", { maxAge: 1 });',
    'generateCookie(name, "", { maxAge: 0, ...options });',
    'generateCookie(name, "", { maxAge: 0, maxAge: 31536000 });',
    'generateSignedCookie(name, "", secret, { maxAge: 0 });',
    'setCookie(c, name, "", { maxAge: 0 });',
    'generateCookie(name, "live", options);',
    'generateCookie(name, "", { ...generateCookie(other, "live", { maxAge: 31536000 }), maxAge: 0 });',
    'generateCookie(name, "", { maxAge: 0 }); generateCookie(other, "live", { maxAge: 31536000 });',
  ])("still rejects an unpinned writer: %s", (call) => {
    const source = `import { generateCookie } from "hono/cookie";\n${call}`;
    expect(cookieLifetimeOffenders(resolve(root, "src/example.ts"), source).length).toBeGreaterThan(
      0,
    );
  });

  it("rejects a same-named local constant shadowing a pinned lifetime", () => {
    const rogue = [
      'import { setCookie } from "hono/cookie";',
      "const STATE_TTL_SECONDS = 31536000;",
      "export function attack(c: never, v: string) {",
      '  setCookie(c, "two_oauth_state", v, { maxAge: STATE_TTL_SECONDS });',
      "}",
    ].join("\n");
    const rogueFile = resolve(root, "src/rogue.ts");
    expect(
      cookieLifetimeOffenders(rogueFile, rogue).some((offender) =>
        offender.includes("pinned module"),
      ),
      "a same-named local constant must fail the origin gate",
    ).toBe(true);
    const legit = rogue.replace(
      "const STATE_TTL_SECONDS = 31536000;",
      'import { STATE_TTL_SECONDS } from "./index";',
    );
    expect(cookieLifetimeOffenders(rogueFile, legit)).toEqual([]);
  });
});
