// Composition-limits acceptance: persistent hints and live counts in SSR.
//
// Both profile editors (Hono ProfilePage and Kit ProfileView) explain the
// composition limits before a member tries to save: a persistent hint per
// field plus a live counter seeded with the rendered values. Contract:
//
// - Bio hint `profile-bio-hint`: "Up to 1000 characters."
// - Bio count `profile-bio-count`: "{n} of 1000 characters", over-budget
//   "{n} of 1000 characters ({o} over the limit)". n counts Unicode code
//   points ([...value].length), never UTF-16 units.
// - Games hint `profile-games-text-hint`:
//   "Up to 20 games, one per line: 80 characters per game, 1700 characters total."
// - Games count `profile-games-text-count`:
//   "{d} of 20 games, {r} of 1700 characters", with " ({o} over the limit)"
//   inside an over-budget segment and ", line {n} over 80 characters" /
//   ", lines {a}, {b} over 80 characters" for overlong trimmed lines.
//   d counts distinct trimmed nonblank names (case-sensitive); r counts raw
//   code points; splitting is CRLF/CR/LF like the server validator.
// - Hint and count sit BEFORE their label (helper text above the field), so
//   the existing `</label><p id="*-error"` adjacency contract is untouched
//   and control accessible names are unchanged.
// - aria-describedby is exactly "hint count", with the field-error id
//   appended while its error renders. No native maxlength anywhere: UTF-16
//   maxlengths cannot express code-point limits.
// - Count nodes are plain text: no aria-live and no role, so typing never
//   announces. Over-budget state is words ("over the limit"), never color
//   alone. Timezone and the new-member CTA are unchanged.
//
// Failing-first Test Author handoff: these assertions fail until the Builder
// lands the SSR change. Builder must not edit this file; defects return as a
// bounded follow-up.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { URL, fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { jsx } from "hono/jsx";
import { beforeAll, describe, expect, it } from "vitest";
import { ProfilePage } from "../src/profiles/pages";
import type { MemberView } from "../src/profiles/store";

const BIO_HINT_ID = "profile-bio-hint";
const BIO_COUNT_ID = "profile-bio-count";
const GAMES_HINT_ID = "profile-games-text-hint";
const GAMES_COUNT_ID = "profile-games-text-count";
const BIO_HINT_COPY = "Up to 1000 characters.";
const GAMES_HINT_COPY =
  "Up to 20 games, one per line: 80 characters per game, 1700 characters total.";

const APP_URL = "https://next.example.test";

const honoMember: MemberView = {
  id: "100000000000000001",
  username: "Fixture",
  avatar: null,
  bio: "Original bio",
  games: ["Chess"],
  timezone: "UTC",
} as MemberView;

type HonoFormDraft = { bio: string; games_text: string; timezone: string };

const renderHono = (
  errors?: Record<string, string>,
  values?: HonoFormDraft,
  member: MemberView = honoMember,
): string =>
  String(
    jsx(ProfilePage, {
      member,
      isOwner: true,
      appUrl: APP_URL,
      ...(errors ? { errors } : {}),
      // Omit `values` unless the case passes one: ProfilePage renders
      // `values ?? member`, so the fresh-member case exercises the stored
      // record (like the Kit twin) instead of contradicting the
      // values-precedence rule.
      ...(values ? { values: { ...values, leaderboard_opt_out: false } } : {}),
    }),
  );

// --- Small HTML readers (attribute-order tolerant, value strict) ---

const openingTag = (html: string, id: string): string | null =>
  html.match(new RegExp(`<([a-z]+)\\b[^>]*\\bid="${id}"[^>]*>`))?.[0] ?? null;

const describedBy = (html: string, id: string): string | null =>
  openingTag(html, id)?.match(/aria-describedby="([^"]*)"/)?.[1] ?? null;

const nodeText = (html: string, id: string): string | null =>
  html.match(new RegExp(`<p\\b[^>]*\\bid="${id}"[^>]*>([\\s\\S]*?)</p>`))?.[1] ?? null;

const expectHintPair = (
  html: string,
  hintId: string,
  countId: string,
  hintCopy: string,
  countText: string,
) => {
  const hintTag = openingTag(html, hintId);
  expect(hintTag, `${hintId} renders`).not.toBeNull();
  expect(hintTag).toContain('class="profile-hint"');
  expect(nodeText(html, hintId)).toBe(hintCopy);
  const countTag = openingTag(html, countId);
  expect(countTag, `${countId} renders`).not.toBeNull();
  expect(countTag).not.toMatch(/aria-live/);
  expect(countTag).not.toMatch(/\brole=/);
  expect(nodeText(html, countId)).toBe(countText);
  // Helper text above the field: hint, then count, then the label.
  expect(html).toMatch(
    new RegExp(
      `<p\\b[^>]*\\bid="${hintId}"[^>]*>[\\s\\S]*?</p>\\s*` +
        `<p\\b[^>]*\\bid="${countId}"[^>]*>[\\s\\S]*?</p>\\s*<label\\b`,
    ),
  );
};

const expectNoMaxlength = (html: string, id: string) => {
  expect(openingTag(html, id), `${id} renders`).not.toBeNull();
  expect(openingTag(html, id)).not.toMatch(/maxlength/i);
};

// Label/error adjacency tolerating Svelte 5 SSR hydration markers. Finds the
// error node's <p> opening, takes the nearest </label> before it, and scans
// the segment between with indexOf only: whitespace and <!-- ... --> tokens
// pass, unterminated comments or any other content fail. No nested-quantifier
// regex, so no backtracking (js/polynomial-redos); no global comment-strip
// rewrite (js/incomplete-multi-character-sanitization). Precedent:
// test/kit-join-attempt-detail-pairing-acceptance.test.mjs.
const expectLabelErrorAdjacency = (html: string, errorId: string) => {
  let errorStart = -1;
  let search = 0;
  while (true) {
    const open = html.indexOf("<p", search);
    if (open === -1) break;
    const tagEnd = html.indexOf(">", open);
    if (tagEnd === -1) break;
    if (html.slice(open, tagEnd + 1).includes(`id="${errorId}"`)) {
      errorStart = open;
      break;
    }
    search = open + 2;
  }
  expect(errorStart, `${errorId} renders`).not.toBe(-1);
  if (errorStart === -1) return;
  let labelEnd = -1;
  search = 0;
  while (true) {
    const found = html.indexOf("</label>", search);
    if (found === -1 || found >= errorStart) break;
    labelEnd = found;
    search = found + 1;
  }
  expect(labelEnd, `${errorId} follows a label`).not.toBe(-1);
  if (labelEnd === -1) return;
  const segment = html.slice(labelEnd + "</label>".length, errorStart);
  let cursor = 0;
  let valid = true;
  while (cursor < segment.length) {
    const ch = segment[cursor]!;
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f" || ch === "\v") {
      cursor += 1;
      continue;
    }
    if (segment.startsWith("<!--", cursor)) {
      const end = segment.indexOf("-->", cursor + 4);
      if (end === -1) {
        valid = false;
        break;
      }
      cursor = end + 3;
      continue;
    }
    valid = false;
    break;
  }
  expect(valid, `${errorId} hugs its label`).toBe(true);
};

describe("Hono profile editor: composition hints and counts", () => {
  it("bio control carries hint+count association, exact copy, initial count, no maxlength", () => {
    const html = renderHono();
    expect(describedBy(html, "profile-bio")).toBe(`${BIO_HINT_ID} ${BIO_COUNT_ID}`);
    expectHintPair(html, BIO_HINT_ID, BIO_COUNT_ID, BIO_HINT_COPY, "12 of 1000 characters");
    expectNoMaxlength(html, "profile-bio");
  });

  it("games control carries hint+count association, exact copy, initial count, no maxlength", () => {
    const html = renderHono();
    expect(describedBy(html, "profile-games-text")).toBe(`${GAMES_HINT_ID} ${GAMES_COUNT_ID}`);
    expectHintPair(
      html,
      GAMES_HINT_ID,
      GAMES_COUNT_ID,
      GAMES_HINT_COPY,
      "1 of 20 games, 5 of 1700 characters",
    );
    expectNoMaxlength(html, "profile-games-text");
  });

  it("initial counts follow the submitted values: emoji is one code point, dupes collapse", () => {
    const html = renderHono(undefined, {
      bio: "hi 🎮",
      games_text: "Go\nGo\n\nChess",
      timezone: "UTC",
    });
    expect(nodeText(html, BIO_COUNT_ID)).toBe("4 of 1000 characters");
    expect(nodeText(html, GAMES_COUNT_ID)).toBe("2 of 20 games, 12 of 1700 characters");
  });

  it("boundary values show the at-limit state with no over wording", () => {
    const gamesAtLimit = Array.from({ length: 20 }, (_, i) => `game${i}`);
    const html = renderHono(undefined, {
      bio: "a".repeat(1000),
      games_text: gamesAtLimit.join("\n"),
      timezone: "UTC",
    });
    expect(nodeText(html, BIO_COUNT_ID)).toBe("1000 of 1000 characters");
    expect(nodeText(html, GAMES_COUNT_ID)).toBe("20 of 20 games, 129 of 1700 characters");
    expect(nodeText(html, BIO_COUNT_ID)).not.toContain("over");
    expect(nodeText(html, GAMES_COUNT_ID)).not.toContain("over");
  });

  it("field errors append after hint+count tokens; error adjacency to the label is preserved", () => {
    const html = renderHono(
      {
        bio: "Keep your bio to 1000 characters or fewer.",
        games: "Add no more than 20 games.",
        timezone: "Choose a valid IANA timezone, e.g. Europe/London.",
      },
      { bio: "hi 🎮", games_text: "Go\nGo\n\nChess", timezone: "Mars/Olympus" },
    );
    expect(describedBy(html, "profile-bio")).toBe(
      `${BIO_HINT_ID} ${BIO_COUNT_ID} profile-bio-error`,
    );
    expect(describedBy(html, "profile-games-text")).toBe(
      `${GAMES_HINT_ID} ${GAMES_COUNT_ID} profile-games-text-error`,
    );
    expect(describedBy(html, "profile-timezone")).toBe("profile-timezone-error");
    expect(nodeText(html, BIO_COUNT_ID)).toBe("4 of 1000 characters");
    expect(nodeText(html, GAMES_COUNT_ID)).toBe("2 of 20 games, 12 of 1700 characters");
    // The established error contract still holds: errors sit directly after
    // their label, outside the accessible name.
    expect(html).toMatch(/<\/label><p id="profile-bio-error"/);
    expect(html).toMatch(/<\/label><p id="profile-games-text-error"/);
    expect(html).toMatch(/<\/label><p id="profile-timezone-error"/);
  });

  it("unknown errors keep hints with no fabricated error association", () => {
    const html = renderHono({
      fields: "Only your bio, games, timezone and leaderboard setting can be changed.",
    });
    expect(describedBy(html, "profile-bio")).toBe(`${BIO_HINT_ID} ${BIO_COUNT_ID}`);
    expect(describedBy(html, "profile-games-text")).toBe(`${GAMES_HINT_ID} ${GAMES_COUNT_ID}`);
    expect(nodeText(html, BIO_HINT_ID)).toBe(BIO_HINT_COPY);
    expect(nodeText(html, GAMES_HINT_ID)).toBe(GAMES_HINT_COPY);
    expect(html).not.toContain("aria-invalid");
  });

  it("count text for hostile values is a plain number string, never markup", () => {
    const html = renderHono(undefined, { bio: "<b>x</b>", games_text: "", timezone: "UTC" });
    expect(nodeText(html, BIO_COUNT_ID)).toBe("8 of 1000 characters");
    expect(nodeText(html, BIO_COUNT_ID)).not.toContain("<");
  });

  it("every describedby token resolves to a node id, with no duplicate ids", () => {
    const html = renderHono({
      bio: "Bad bio.",
      games: "Bad games.",
      timezone: "Bad zone.",
      fields: "Global problem.",
    });
    const ids = [...html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]!);
    expect(new Set(ids).size).toBe(ids.length);
    const tokens = [...html.matchAll(/aria-describedby="([^"]+)"/g)].flatMap((m) =>
      m[1]!.split(/\s+/),
    );
    for (const token of [
      BIO_HINT_ID,
      BIO_COUNT_ID,
      GAMES_HINT_ID,
      GAMES_COUNT_ID,
      "profile-bio-error",
      "profile-games-text-error",
      "profile-timezone-error",
    ])
      expect(tokens).toContain(token);
    for (const token of tokens) expect(ids, token).toContain(token);
  });

  it("timezone control and new-member CTA are unchanged", () => {
    const html = renderHono();
    expect(describedBy(html, "profile-timezone")).toBeNull();
    expect(openingTag(html, "profile-timezone")).toContain('placeholder="Europe/London"');
    expect(html).not.toContain("profile-timezone-hint");
    expect(html).not.toContain("profile-timezone-count");

    const fresh = renderHono(undefined, undefined, {
      ...honoMember,
      username: "Newbie",
      bio: null,
      games: [],
      timezone: null,
    } as MemberView);
    expect(fresh).toContain('data-testid="profile-new-member-cta"');
    expect(fresh).toContain('href="#edit-heading"');
    expect(fresh).toContain("Add profile details");
    expect(nodeText(fresh, BIO_COUNT_ID)).toBe("0 of 1000 characters");
    expect(nodeText(fresh, GAMES_COUNT_ID)).toBe("0 of 20 games, 0 of 1700 characters");
  });
});

// --- Kit twin: SSR-compile the real ProfileView (same harness shape as
// test/kit-profile-form.test.ts) and assert the identical contract. ---

const webRequire = createRequire(new URL("../web/package.json", import.meta.url));
const { compile } = webRequire("svelte/compiler") as {
  compile: (
    source: string,
    options: { generate: string; dev: boolean; filename: string },
  ) => { js: { code: string } };
};

type RenderView = (props: Record<string, unknown>) => string;

let renderView: RenderView;

const KIT_MEMBER: MemberView = {
  id: "100000000000000001",
  username: "alice",
  avatar: null,
  bio: "Alice bio",
  games: ["Chess"],
  timezone: "Europe/London",
  leaderboardOptOut: false,
} as MemberView;

const kitProps = (overrides: Record<string, unknown> = {}) => ({
  member: KIT_MEMBER,
  stats: null,
  isOwner: true,
  isModerator: false,
  appUrl: APP_URL,
  joinResult: null,
  ...overrides,
});

beforeAll(async () => {
  const worktree = fileURLToPath(new URL("../", import.meta.url));
  const scratch = mkdtempSync(join(tmpdir(), "kit-profile-composition-"));
  const entry = join(scratch, "kit-profile-composition-entry.mjs");
  writeFileSync(
    entry,
    `
import { render } from "svelte/server";
import View from ${JSON.stringify(join(worktree, "web/src/lib/ProfileView.svelte"))};
export function renderView(props) {
  const { body } = render(View, { props });
  return body;
}
`,
  );
  const outfile = join(scratch, "kit-profile-composition.mjs");
  await build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile,
    logLevel: "warning",
    absWorkingDir: worktree,
    nodePaths: [join(worktree, "web/node_modules"), join(worktree, "node_modules")],
    plugins: [
      {
        name: "kit-profile-composition-svelte-ssr",
        setup(plugin) {
          plugin.onLoad({ filter: /\.svelte$/ }, (args) => {
            const source = readFileSync(args.path, "utf8");
            const { js } = compile(source, {
              generate: "server",
              dev: false,
              filename: args.path,
            });
            return { contents: js.code, loader: "js", resolveDir: dirname(args.path) };
          });
        },
      },
    ],
  });
  ({ renderView } = (await import(pathToFileURL(outfile).href)) as {
    renderView: RenderView;
  });
  rmSync(scratch, { recursive: true, force: true });
}, 120000);

describe("Kit profile editor: composition hints and counts", () => {
  it("bio control carries hint+count association, exact copy, initial count, no maxlength", () => {
    const html = renderView(kitProps());
    expect(describedBy(html, "profile-bio")).toBe(`${BIO_HINT_ID} ${BIO_COUNT_ID}`);
    expectHintPair(html, BIO_HINT_ID, BIO_COUNT_ID, BIO_HINT_COPY, "9 of 1000 characters");
    expectNoMaxlength(html, "profile-bio");
  });

  it("games control carries hint+count association, exact copy, initial count, no maxlength", () => {
    const html = renderView(kitProps());
    expect(describedBy(html, "profile-games-text")).toBe(`${GAMES_HINT_ID} ${GAMES_COUNT_ID}`);
    expectHintPair(
      html,
      GAMES_HINT_ID,
      GAMES_COUNT_ID,
      GAMES_HINT_COPY,
      "1 of 20 games, 5 of 1700 characters",
    );
    expectNoMaxlength(html, "profile-games-text");
  });

  it("initial counts follow the submitted values: emoji is one code point, dupes collapse", () => {
    const html = renderView(
      kitProps({
        values: {
          bio: "hi 🎮",
          games_text: "Go\nGo\n\nChess",
          timezone: "UTC",
          leaderboard_opt_out: false,
        },
      }),
    );
    expect(nodeText(html, BIO_COUNT_ID)).toBe("4 of 1000 characters");
    expect(nodeText(html, GAMES_COUNT_ID)).toBe("2 of 20 games, 12 of 1700 characters");
  });

  it("boundary values show the at-limit state with no over wording", () => {
    const gamesAtLimit = Array.from({ length: 20 }, (_, i) => `game${i}`);
    const html = renderView(
      kitProps({
        values: {
          bio: "a".repeat(1000),
          games_text: gamesAtLimit.join("\n"),
          timezone: "UTC",
          leaderboard_opt_out: false,
        },
      }),
    );
    expect(nodeText(html, BIO_COUNT_ID)).toBe("1000 of 1000 characters");
    expect(nodeText(html, GAMES_COUNT_ID)).toBe("20 of 20 games, 129 of 1700 characters");
  });

  it("field errors append after hint+count tokens; error adjacency to the label is preserved", () => {
    const html = renderView(
      kitProps({
        errors: {
          bio: "Keep your bio to 1000 characters or fewer.",
          games: "Add no more than 20 games.",
          timezone: "Choose a valid IANA timezone, e.g. Europe/London.",
        },
        values: {
          bio: "hi 🎮",
          games_text: "Go\nGo\n\nChess",
          timezone: "Mars/Olympus",
          leaderboard_opt_out: false,
        },
      }),
    );
    expect(describedBy(html, "profile-bio")).toBe(
      `${BIO_HINT_ID} ${BIO_COUNT_ID} profile-bio-error`,
    );
    expect(describedBy(html, "profile-games-text")).toBe(
      `${GAMES_HINT_ID} ${GAMES_COUNT_ID} profile-games-text-error`,
    );
    expect(describedBy(html, "profile-timezone")).toBe("profile-timezone-error");
    expect(nodeText(html, BIO_COUNT_ID)).toBe("4 of 1000 characters");
    expect(nodeText(html, GAMES_COUNT_ID)).toBe("2 of 20 games, 12 of 1700 characters");
    // Svelte 5 SSR wraps the conditional error block in hydration markers
    // (`<!--[0-->`), so tolerate comments between the label and the error node.
    expectLabelErrorAdjacency(html, "profile-bio-error");
    expectLabelErrorAdjacency(html, "profile-games-text-error");
  });

  it("unknown errors keep hints with no fabricated error association", () => {
    const html = renderView(
      kitProps({
        errors: {
          fields: "Only your bio, games, timezone and leaderboard setting can be changed.",
        },
        values: { bio: "", games_text: "", timezone: "", leaderboard_opt_out: false },
      }),
    );
    expect(describedBy(html, "profile-bio")).toBe(`${BIO_HINT_ID} ${BIO_COUNT_ID}`);
    expect(describedBy(html, "profile-games-text")).toBe(`${GAMES_HINT_ID} ${GAMES_COUNT_ID}`);
    expect(nodeText(html, BIO_HINT_ID)).toBe(BIO_HINT_COPY);
    expect(nodeText(html, GAMES_HINT_ID)).toBe(GAMES_HINT_COPY);
    expect(html).not.toContain("aria-invalid");
  });

  it("every describedby token resolves to a node id, with no duplicate ids", () => {
    const html = renderView(
      kitProps({
        errors: {
          bio: "Bad bio.",
          games: "Bad games.",
          timezone: "Bad zone.",
          fields: "Global problem.",
        },
        values: { bio: "", games_text: "", timezone: "", leaderboard_opt_out: false },
      }),
    );
    const ids = [...html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]!);
    expect(new Set(ids).size).toBe(ids.length);
    const tokens = [...html.matchAll(/aria-describedby="([^"]+)"/g)].flatMap((m) =>
      m[1]!.split(/\s+/),
    );
    for (const token of [
      BIO_HINT_ID,
      BIO_COUNT_ID,
      GAMES_HINT_ID,
      GAMES_COUNT_ID,
      "profile-bio-error",
      "profile-games-text-error",
      "profile-timezone-error",
    ])
      expect(tokens).toContain(token);
    for (const token of tokens) expect(ids, token).toContain(token);
  });

  it("timezone control and new-member CTA are unchanged", () => {
    const html = renderView(kitProps());
    expect(describedBy(html, "profile-timezone")).toBeNull();
    expect(openingTag(html, "profile-timezone")).toContain('placeholder="Europe/London"');
    expect(html).not.toContain("profile-timezone-hint");
    expect(html).not.toContain("profile-timezone-count");

    const fresh = renderView(
      kitProps({
        member: { ...KIT_MEMBER, username: "Newbie", bio: null, games: [], timezone: null },
      }),
    );
    expect(fresh).toContain('data-testid="profile-new-member-cta"');
    expect(fresh).toContain('href="#edit-heading"');
    expect(fresh).toContain("Add profile details");
    expect(nodeText(fresh, BIO_COUNT_ID)).toBe("0 of 1000 characters");
    expect(nodeText(fresh, GAMES_COUNT_ID)).toBe("0 of 20 games, 0 of 1700 characters");
  });
});
