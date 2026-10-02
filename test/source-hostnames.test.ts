// TOG-12552: our own hostnames appear in src/ only as reviewed pins.
//
// Ports legacy two-web NoHardcodedHostnamesTest. A stray production or staging
// hostname is how a staging build ends up calling production, or how a
// host-pinned allowlist drifts from configuration. Every src/ line that names
// one of our hosts must equal a reviewed entry in REVIEWED_PINS, and every
// entry must still match exactly one line, so a removed pin takes its entry
// with it.
//
// The scan reads raw text, comments included. A tokenizer that skipped comments
// could also skip a literal it misparsed, and this guard must fail closed. A
// host split across concatenated literals still evades it; catching that is the
// reviewer's job, not something a text scan can prove.
import { readdirSync, readFileSync } from "node:fs";
import { URL } from "node:url";
import { describe, expect, it } from "vitest";

const root = new URL("../", import.meta.url);
const THIS_FILE = "test/source-hostnames.test.ts";

// Hosts are case-insensitive, and the optional backslash catches the escaped
// form a RegExp would carry. `togetherweown.com` also covers every subdomain,
// next.togetherweown.com included.
const HOSTNAME_PATTERNS = [/togetherweown\\?\.com/i, /discord\\?\.gg\\?\//i];

type Pin = { file: string; line: string; reason: string };
type Hit = { file: string; lineNo: number; line: string };

// `line` is the whole source line, trimmed. Editing a pinned line needs a new
// review, so the entry has to change with it.
const REVIEWED_PINS: Pin[] = [
  {
    file: "src/qa.ts",
    line: 'export const STAGING_APP_URL = "https://next.togetherweown.com";',
    reason:
      "QA sign-in exists only where APP_URL equals this exact staging origin; the pin is the gate.",
  },
  {
    file: "src/qa.ts",
    line: "// Env gate: `APP_URL` must be the staging host (`https://next.togetherweown.com`)",
    reason: "Comment documenting the STAGING_APP_URL gate.",
  },
  {
    file: "src/headers.ts",
    line: 'const PRODUCTION_APEX = "togetherweown.com";',
    reason:
      "Only the production apex may be indexed; every other host gets noindex (fails closed).",
  },
  {
    file: "src/probes/internal-action-drill.ts",
    line: 'const PRODUCTION_APEX = "togetherweown.com";',
    reason: "Duplicates the src/headers.ts apex so the drill refuses a production APP_URL.",
  },
  {
    file: "src/probes/internal-action-drill.ts",
    line: "* (next.togetherweown.com) is staging and is admitted; only the apex itself",
    reason: "Doc comment for resolveDrillWebOrigin.",
  },
  {
    file: "src/probes/internal-action-drill.ts",
    line: '"APP_URL is missing: the drill runs against the staging web origin only — set APP_URL explicitly (e.g. https://next.togetherweown.com).",',
    reason: "Operator hint in the misconfiguration error; message text, never a request target.",
  },
  {
    file: "src/invite.ts",
    line: 'export const FALLBACK_INVITE = "https://discord.gg/4GwEDNRTtx";',
    reason:
      "Last-resort public invite when DISCORD_INVITE_URL is unusable (legacy FALLBACK_INVITE).",
  },
];

function srcFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(new URL(dir, root), { withFileTypes: true })) {
      const rel = `${dir}${entry.name}`;
      if (entry.isDirectory()) walk(`${rel}/`);
      else if (entry.isFile()) out.push(rel);
    }
  };
  walk("src/");
  return out.sort();
}

function hostnameHits(file: string, source: string): Hit[] {
  return source
    .split(/\r?\n/)
    .flatMap((text, i) =>
      HOSTNAME_PATTERNS.some((pattern) => pattern.test(text))
        ? [{ file, lineNo: i + 1, line: text.trim() }]
        : [],
    );
}

function auditPins(hits: Hit[], pins: Pin[]): string[] {
  const problems: string[] = [];
  const same = (a: { file: string; line: string }, b: { file: string; line: string }) =>
    a.file === b.file && a.line === b.line;
  for (const hit of hits) {
    if (pins.some((pin) => same(pin, hit))) continue;
    problems.push(
      `${hit.file}:${hit.lineNo} hard-codes one of our hostnames outside the reviewed allowlist:\n` +
        `    ${hit.line}\n` +
        "  Read the host from configuration (APP_URL, DISCORD_INVITE_URL) instead. If the literal\n" +
        `  is deliberate, add this entry to REVIEWED_PINS in ${THIS_FILE} and give a\n` +
        "  one-line reason why it cannot come from configuration:\n" +
        `    { file: ${JSON.stringify(hit.file)}, line: ${JSON.stringify(hit.line)}, reason: "..." }`,
    );
  }
  pins.forEach((pin, i) => {
    const where = `REVIEWED_PINS entry for ${pin.file} (${JSON.stringify(pin.line)})`;
    if (pin.reason.trim() === "") problems.push(`${where} has no reason. Say why the pin exists.`);
    if (pins.findIndex((other) => same(other, pin)) !== i) {
      problems.push(`${where} is listed twice. Delete the duplicate.`);
    }
    const matches = hits.filter((hit) => same(pin, hit));
    if (matches.length === 0) {
      problems.push(
        `${where} matches no line any more. If the pin was removed, delete the entry; ` +
          "if the line changed, update the entry so the new line gets reviewed.",
      );
    } else if (matches.length > 1) {
      const lines = matches.map((hit) => hit.lineNo).join(", ");
      problems.push(
        `${where} matches lines ${lines}. Each entry pins one line: reuse one constant ` +
          "instead of repeating the literal.",
      );
    }
  });
  return problems;
}

describe("hard-coded hostnames under src/", () => {
  it("are all reviewed pins, and every pin still matches exactly one line", () => {
    const hits = srcFiles().flatMap((file) =>
      hostnameHits(file, readFileSync(new URL(file, root), "utf8")),
    );
    expect(auditPins(hits, REVIEWED_PINS)).toEqual([]);
  });
});

describe("hostname scanner", () => {
  it.each([
    'fetch("https://togetherweown.com/api")',
    "const url = `https://${sub}.TogetherWeOwn.COM/x`;",
    "const host = /^next\\.togetherweown\\.com$/;",
    '"https://discord.gg/abc123"',
    "// see https://next.togetherweown.com for staging",
    "  * or togetherweown.com in a JSDoc line",
  ])("flags %s", (line) => {
    expect(hostnameHits("src/x.ts", line)).toEqual([
      { file: "src/x.ts", lineNo: 1, line: line.trim() },
    ]);
  });

  it.each([
    'parts.hostname === "discord.gg"',
    'const site = "https://example.com";',
    "const name = 'togetherweown';",
  ])("does not flag %s", (line) => {
    expect(hostnameHits("src/x.ts", line)).toEqual([]);
  });

  it("reports line numbers across CRLF and LF sources", () => {
    const hits = hostnameHits("src/x.ts", "a\r\nb\nconst h = 'togetherweown.com';\r\n");
    expect(hits.map((hit) => hit.lineNo)).toEqual([3]);
  });
});

describe("pin audit", () => {
  const pin: Pin = { file: "src/a.ts", line: 'const H = "togetherweown.com";', reason: "test pin" };

  it("names the file, line and allowlist entry for an unlisted hostname", () => {
    const [problem, ...rest] = auditPins(
      [
        { file: "src/a.ts", lineNo: 4, line: pin.line },
        { file: "src/b.ts", lineNo: 12, line: 'fetch("https://togetherweown.com/x")' },
      ],
      [pin],
    );
    expect(rest).toEqual([]);
    expect(problem).toContain("src/b.ts:12 hard-codes one of our hostnames");
    expect(problem).toContain(`REVIEWED_PINS in ${THIS_FILE}`);
    expect(problem).toContain('file: "src/b.ts"');
    expect(problem).toContain(`line: ${JSON.stringify('fetch("https://togetherweown.com/x")')}`);
    expect(problem).toContain("reason:");
  });

  it("does not accept the same line from another file", () => {
    const problems = auditPins([{ file: "src/b.ts", lineNo: 1, line: pin.line }], [pin]);
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain("src/b.ts:1 hard-codes");
    expect(problems[1]).toContain("matches no line any more");
  });

  it("fails a stale entry whose pin was removed", () => {
    expect(auditPins([], [pin])).toEqual([
      expect.stringContaining("matches no line any more. If the pin was removed, delete the entry"),
    ]);
  });

  it("fails an entry that matches the same literal on two lines", () => {
    const hits = [3, 9].map((lineNo) => ({ file: "src/a.ts", lineNo, line: pin.line }));
    expect(auditPins(hits, [pin])).toEqual([expect.stringContaining("matches lines 3, 9")]);
  });

  it("fails a duplicate entry and an entry without a reason", () => {
    const hits = [{ file: "src/a.ts", lineNo: 1, line: pin.line }];
    expect(auditPins(hits, [pin, pin])).toEqual([expect.stringContaining("is listed twice")]);
    expect(auditPins(hits, [{ ...pin, reason: " " }])).toEqual([
      expect.stringContaining("has no reason"),
    ]);
  });
});
