// Tier-0 validator property tests (REPORT-ONLY): fast-check over the
// join/events/profiles request schemas plus the moderator allowlist parser,
// modelled on test/admin-validation.property.test.ts. Seeded and bounded (100
// runs) so the report-only CI step stays fast; every oracle below re-states
// the documented contract with an independent literal, so a refactor that
// changes behaviour fails here rather than silently.
//
// Pure fixtures only: no app, database, network or Discord calls. Modules
// under test are imported for their pure validators; none of these properties
// performs I/O.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { eventKeyAllowed, canonicalEventKey } from "../src/events/keys";
import { normalizePastPage, normalizeUpcomingPage, PAGE_SIZE } from "../src/events/reads";
import { EVENTS_UPCOMING_PAGE_SIZE } from "../src/islands/contracts";
import { isRsvpStatus } from "../src/events/rsvp";
import { RSVP_STATUSES } from "../src/islands/contracts-rsvp-button";
import { resolveCalendarInput } from "../src/events/page-models.server";
import { MAX_QUERY_LENGTH, matchQuery, normalizeQuery } from "../src/events/search-log";
import { sanitizeSource, safeNext } from "../src/join/service";
import { validateProfile } from "../src/profiles/validation";
import { STAGING_APP_URL } from "../src/qa";
import { isModerator, parseModeratorRoleIds } from "../src/roles";

const OPTIONS = { seed: 19263, numRuns: 100 };
const PROD_URL = "https://app.example.test";

// ---------------------------------------------------------------------------
// join: source + next validators (src/join/service.ts)
// ---------------------------------------------------------------------------

/** Independent oracle for sanitizeSource: the documented legacy shape. */
function sourceOracle(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  return /^[a-z0-9][a-z0-9:_-]{0,63}$/i.test(raw) ? raw : null;
}

/** C0 controls and DEL, checked by code point so no control escape silences a checker. */
function hasControlByte(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/** Independent oracle for safeNext: the documented SafeRedirect shape. */
function nextOracle(raw: unknown): string | null {
  if (typeof raw !== "string" || raw === "" || /\s/.test(raw) || hasControlByte(raw)) return null;
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\")) return null;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw)) return null;
  try {
    const u = new URL(raw, "https://join.invalid");
    if (u.origin !== "https://join.invalid") return null;
  } catch {
    return null;
  }
  return raw;
}

const HOSTILE_NEXT = [
  "",
  "//evil.example.test/x",
  "///",
  "https://app.example.test/join",
  "http:/single-slash",
  "/back\\slash",
  "/has space",
  "/has\ttab",
  "/has\nnewline",
  "/nul\0byte",
  "javascript:alert(1)",
  "java\tscript:/x",
  "data:text/plain,hi",
  "relative/path",
  "?query-only",
  "#fragment-only",
];

const pathSegment = fc
  .array(fc.constantFrom("a", "Z", "0", ".", "-", "_", "~", "%41"), {
    minLength: 1,
    maxLength: 12,
  })
  .map((chars) => chars.join(""));
const safePath = fc
  .array(pathSegment, { minLength: 1, maxLength: 4 })
  .map((segments) => `/${segments.join("/")}`);

describe("tier-0 join request validators", () => {
  it("sanitizeSource keeps exactly the documented legacy shape", () => {
    fc.assert(
      fc.property(fc.anything(), (raw) => {
        expect(sanitizeSource(raw)).toBe(sourceOracle(raw));
      }),
      OPTIONS,
    );
  });

  it("sanitizeSource results stay bounded and idempotent", () => {
    fc.assert(
      fc.property(fc.string(), (raw) => {
        const kept = sanitizeSource(raw);
        if (kept !== null) {
          expect(kept.length).toBeLessThanOrEqual(64);
          expect(kept).toMatch(/^[a-z0-9]/i);
          expect(sanitizeSource(kept)).toBe(kept);
        }
      }),
      OPTIONS,
    );
  });

  it("safeNext keeps exactly the documented same-origin shape", () => {
    fc.assert(
      fc.property(fc.anything(), (raw) => {
        expect(safeNext(raw)).toBe(nextOracle(raw));
      }),
      OPTIONS,
    );
  });

  it("safeNext refuses hostile constants", () => {
    fc.assert(
      fc.property(fc.constantFrom(...HOSTILE_NEXT), (raw) => {
        expect(safeNext(raw)).toBeNull();
      }),
      OPTIONS,
    );
  });

  it("safeNext keeps generated safe paths, with or without a query", () => {
    fc.assert(
      fc.property(safePath, fc.boolean(), (path, withQuery) => {
        const raw = withQuery ? `${path}?next=${encodeURIComponent(path)}` : path;
        expect(safeNext(raw)).toBe(raw);
        expect(safeNext(safeNext(raw)!)).toBe(raw);
      }),
      OPTIONS,
    );
  });
});

// ---------------------------------------------------------------------------
// events: keys, paging, calendar input, search, RSVP status
// ---------------------------------------------------------------------------

// Crockford base32 without I/L/O/U, matching the ULID_KEY literal.
const ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ulidLike = fc
  .array(fc.constantFrom(...ULID_ALPHABET), { minLength: 26, maxLength: 26 })
  .chain((chars) =>
    fc
      .array(fc.boolean(), { minLength: 26, maxLength: 26 })
      .map((lower) => chars.map((c, i) => (lower[i] ? c.toLowerCase() : c)).join("")),
  );

describe("tier-0 event key validators", () => {
  it("canonicalEventKey answers exactly for ULID-shaped keys", () => {
    fc.assert(
      fc.property(fc.string(), (key) => {
        const canonical = canonicalEventKey(key);
        if (/^[0-9A-HJKMNP-TV-Z]{26}$/i.test(key)) {
          expect(canonical).toBe(key.toUpperCase());
        } else {
          expect(canonical).toBeNull();
        }
      }),
      OPTIONS,
    );
  });

  it("generated ULIDs round-trip through the canonical form and the prod gate", () => {
    fc.assert(
      fc.property(ulidLike, (key) => {
        const canonical = canonicalEventKey(key)!;
        expect(canonical).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
        expect(canonical).toBe(key.toUpperCase());
        expect(eventKeyAllowed(key, PROD_URL)).toBe(true);
        expect(eventKeyAllowed(canonical, PROD_URL)).toBe(true);
      }),
      OPTIONS,
    );
  });

  it("seed/demo keys open only on staging and local bindings", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 50 }).map((n) => `seed-calendar-${String(n).padStart(2, "0")}`),
        fc.constantFrom(STAGING_APP_URL, "http://localhost:3000/", "http://127.0.0.1:8787/"),
        (key, demoUrl) => {
          expect(eventKeyAllowed(key, demoUrl)).toBe(true);
          expect(eventKeyAllowed(key, PROD_URL)).toBe(false);
          expect(canonicalEventKey(key)).toBeNull();
        },
      ),
      OPTIONS,
    );
  });

  it("non-ULID keys stay refused on the prod gate", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string({ maxLength: 25 }),
          fc.string({ minLength: 27, maxLength: 40 }),
          fc.constantFrom("IIIIIIIIIIIIIIIIIIIIIIIIII", "OOOOOOOOOOOOOOOOOOOOOOOOOO", ""),
        ),
        (key) => {
          // I and O are outside the ULID alphabet, so these never canonicalise.
          if (!/^[0-9A-HJKMNP-TV-Z]{26}$/i.test(key)) {
            expect(canonicalEventKey(key)).toBeNull();
            expect(eventKeyAllowed(key, PROD_URL)).toBe(false);
          }
        },
      ),
      OPTIONS,
    );
  });
});

describe("tier-0 event page normalizers", () => {
  const pageNumber = fc.oneof(
    fc.integer({ min: -1_000_000, max: 1_000_000_000 }),
    fc.double({ noNaN: false }),
    fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, 0, -1, 1.5),
  );

  it("normalizePastPage keeps valid pages and falls back to one", () => {
    fc.assert(
      fc.property(pageNumber, (page) => {
        const valid =
          Number.isSafeInteger(page) && page > 0 && Number.isSafeInteger((page - 1) * PAGE_SIZE);
        expect(normalizePastPage(page)).toBe(valid ? page : 1);
      }),
      OPTIONS,
    );
  });

  it("normalizeUpcomingPage keeps valid pages and falls back to one", () => {
    fc.assert(
      fc.property(pageNumber, (page) => {
        const valid =
          Number.isSafeInteger(page) &&
          page > 0 &&
          Number.isSafeInteger((page - 1) * EVENTS_UPCOMING_PAGE_SIZE);
        expect(normalizeUpcomingPage(page)).toBe(valid ? page : 1);
      }),
      OPTIONS,
    );
  });

  it("normalized pages are always safe positive integers", () => {
    fc.assert(
      fc.property(pageNumber, (page) => {
        for (const out of [normalizePastPage(page), normalizeUpcomingPage(page)]) {
          expect(Number.isSafeInteger(out)).toBe(true);
          expect(out).toBeGreaterThanOrEqual(1);
        }
      }),
      OPTIONS,
    );
  });
});

describe("tier-0 calendar input resolver", () => {
  const maybeText = fc.oneof(fc.constant(undefined), fc.constant(null), fc.string());

  it("bounds the query, forces list view while searching, and passes the rest through", () => {
    fc.assert(
      fc.property(
        fc.record({
          q: maybeText,
          view: maybeText,
          past: maybeText,
          page: maybeText,
          event: maybeText,
          month: maybeText,
        }),
        (input) => {
          const resolved = resolveCalendarInput(input);
          const q = input.q ?? "";
          expect(resolved.q).toBe(q);
          expect(resolved.queryTooLong).toBe([...q].length > MAX_QUERY_LENGTH);
          expect(resolved.searching).toBe(!resolved.queryTooLong && matchQuery(q) !== null);
          if (resolved.searching) expect(resolved.view).toBe("list");
          else expect(resolved.view).toBe(input.view === "calendar" ? "calendar" : "list");
          expect(["list", "calendar"]).toContain(resolved.view);
          expect(resolved.past).toBe(input.past === "1");
          expect(resolved.page).toBe(normalizeUpcomingPage(Number.parseInt(input.page ?? "1", 10)));
          expect(resolved.month).toBe(input.month ?? null);
        },
      ),
      OPTIONS,
    );
  });

  it("strips NUL from the jump key and drops overlong keys without losing the request flag", () => {
    fc.assert(
      fc.property(maybeText, (event) => {
        const resolved = resolveCalendarInput({ event });
        const stripped = (event ?? "").replaceAll(String.fromCharCode(0), "");
        expect(resolved.jumpKey.includes(String.fromCharCode(0))).toBe(false);
        // The flag follows the stripped key: a NUL-only ?event= requests nothing.
        expect(resolved.jumpRequested).toBe(stripped !== "");
        if (stripped !== "" && stripped.length <= 64) expect(resolved.jumpKey).toBe(stripped);
        else expect(resolved.jumpKey).toBe("");
      }),
      { ...OPTIONS, examples: [["\0"], ["\0\0"]] },
    );
  });
});

describe("tier-0 event search matchers", () => {
  it("matchQuery keeps trimmed text and drops blanks and NUL-only input", () => {
    fc.assert(
      fc.property(fc.oneof(fc.constant(undefined), fc.constant(null), fc.string()), (raw) => {
        const matched = matchQuery(raw);
        const trimmed = (raw ?? "").replace(/\0/g, "").trim();
        expect(matched).toBe(trimmed === "" ? null : trimmed);
        if (matched !== null) expect(matched.includes("\0")).toBe(false);
      }),
      OPTIONS,
    );
  });

  it("normalizeQuery collapses, lowercases and caps at the bound", () => {
    fc.assert(
      fc.property(fc.string(), (raw) => {
        const normalized = normalizeQuery(raw);
        const collapsed = raw.replace(/\0/g, "").trim().replace(/\s+/gu, " ").toLowerCase();
        if (collapsed === "") {
          expect(normalized).toBeNull();
        } else {
          expect(normalized).toBe([...collapsed].slice(0, MAX_QUERY_LENGTH).join(""));
          expect([...normalized!].length).toBeLessThanOrEqual(MAX_QUERY_LENGTH);
        }
      }),
      OPTIONS,
    );
  });
});

describe("tier-0 RSVP status guard", () => {
  it("accepts exactly the contracted statuses", () => {
    fc.assert(
      fc.property(fc.anything(), (value) => {
        expect(isRsvpStatus(value)).toBe((RSVP_STATUSES as readonly unknown[]).includes(value));
      }),
      OPTIONS,
    );
    for (const status of RSVP_STATUSES) expect(isRsvpStatus(status)).toBe(true);
    for (const near of ["going ", "GOING", "", "wait_list", "maybe\n", 0, null])
      expect(isRsvpStatus(near)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// profiles: write validation (src/profiles/validation.ts)
// ---------------------------------------------------------------------------

const SAFE_CHAR = fc.constantFrom("a", "Z", "0", " ", "-", "_", ".", "é", "中");
const safeText = (max: number) =>
  fc.array(SAFE_CHAR, { maxLength: max }).map((chars) => chars.join(""));
const CONTROL_CHAR = fc.constantFrom("\0", "\u0007", "\u001b", "\u007f");
const VALID_BASE = { games: ["Chess"], timezone: "" };

describe("tier-0 profile write validation", () => {
  it("accepts in-bounds bios and keeps the trimmed text", () => {
    fc.assert(
      fc.property(safeText(1000), (bio) => {
        const result = validateProfile({ ...VALID_BASE, bio });
        if ([...bio].length <= 1000) {
          expect(result.ok).toBe(true);
          if (result.ok) expect(result.attrs.bio).toBe(bio.trim() === "" ? null : bio.trim());
        }
      }),
      OPTIONS,
    );
  });

  it("rejects overlong bios and control bytes", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          safeText(1000).map((bio) => `${bio}${"x".repeat(1001 - [...bio].length)}`),
          safeText(20).chain((bio) => CONTROL_CHAR.map((c) => `${bio}${c}tail`)),
        ),
        (bio) => {
          const result = validateProfile({ ...VALID_BASE, bio });
          expect(result.ok).toBe(false);
          if (!result.ok) expect(result.errors).toHaveProperty("bio");
        },
      ),
      { ...OPTIONS, examples: [["x".repeat(1001)], ["ok\u0007no"]] },
    );
  });

  it("accepts up to twenty unique trimmed games in order, dropping blanks", () => {
    const gameName = fc
      .array(fc.constantFrom("a", "B", "3", "-", " "), {
        minLength: 1,
        maxLength: 80,
      })
      .map((chars) => chars.join("").trim())
      .filter((name) => name !== "");
    fc.assert(
      fc.property(fc.array(gameName, { maxLength: 20 }), (games) => {
        const unique = [...new Set(games.map((g) => g.trim()))].filter((g) => g !== "");
        const result = validateProfile({
          ...VALID_BASE,
          games: [...games, "  ", ""],
        });
        if (unique.length <= 20 && unique.every((g) => [...g].length <= 80)) {
          expect(result.ok).toBe(true);
          if (result.ok) expect(result.attrs.games).toEqual(unique);
        }
      }),
      OPTIONS,
    );
  });

  it("rejects oversized, overlong and non-text game entries", () => {
    // Oversized means twenty-one kept games: blanks never survive the trim,
    // so every entry carries its index behind a space terminator. The
    // terminator makes the prefix unambiguous, so entries cannot collide
    // back under the twenty-game cap no matter what the names contain.
    const tooMany = fc
      .array(
        safeText(10).filter((name) => name.trim() !== ""),
        {
          minLength: 21,
          maxLength: 25,
        },
      )
      .map((games) => games.map((game, i) => `g${i} ${game.trim()}`));
    fc.assert(
      fc.property(
        fc.oneof(
          tooMany,
          fc.constant([`g${"a".repeat(80)}`]),
          fc.constant([42]),
          fc.constant(["ok", 42]),
        ),
        (games) => {
          const result = validateProfile({ ...VALID_BASE, games });
          expect(result.ok).toBe(false);
          if (!result.ok) expect(result.errors).toHaveProperty("games");
        },
      ),
      { ...OPTIONS, examples: [[["a".repeat(81)]]] },
    );
  });

  it("splits games_text per line and caps the raw text", () => {
    fc.assert(
      fc.property(fc.array(safeText(12), { maxLength: 8 }), (lines) => {
        const games_text = lines.join("\n");
        const result = validateProfile({ ...VALID_BASE, games_text });
        if ([...games_text].length > 1700) {
          expect(result.ok).toBe(false);
        } else if (result.ok) {
          expect(result.attrs.games).not.toContain("");
          expect(result.attrs.games.length).toBeLessThanOrEqual(20);
        }
      }),
      OPTIONS,
    );
  });

  it("refuses games_text past the raw cap", () => {
    fc.assert(
      fc.property(fc.constantFrom("x".repeat(1701), `${"y ".repeat(850)}\n`), (games_text) => {
        const result = validateProfile({ ...VALID_BASE, games_text });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.errors).toHaveProperty("games");
      }),
      OPTIONS,
    );
  });

  it("accepts blank and real IANA zones, rejects the rest", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.constantFrom("", "UTC", "Europe/London", "America/New_York", "Australia/Sydney"),
          fc.string({ minLength: 1 }).filter((tz) => {
            try {
              new Intl.DateTimeFormat("en", { timeZone: tz });
              return false;
            } catch {
              return true;
            }
          }),
          fc.constantFrom(42, null, {}),
        ),
        (timezone) => {
          const result = validateProfile({ ...VALID_BASE, timezone });
          if (timezone === "") {
            expect(result.ok).toBe(true);
            if (result.ok) expect(result.attrs.timezone).toBeNull();
          } else if (typeof timezone === "string") {
            try {
              new Intl.DateTimeFormat("en", { timeZone: timezone });
              expect(result.ok).toBe(true);
            } catch {
              expect(result.ok).toBe(false);
              if (!result.ok) expect(result.errors).toHaveProperty("timezone");
            }
          } else if (timezone === null) {
            expect(result.ok).toBe(true);
          } else {
            expect(result.ok).toBe(false);
            if (!result.ok) expect(result.errors).toHaveProperty("timezone");
          }
        },
      ),
      OPTIONS,
    );
  });
});

// ---------------------------------------------------------------------------
// roles: moderator allowlist parsing (src/roles.ts)
// ---------------------------------------------------------------------------

const SNOWFLAKE = () =>
  fc
    .array(fc.constantFrom(..."0123456789"), { minLength: 10, maxLength: 25 })
    .map((chars) => chars.join(""));

describe("tier-0 moderator allowlist parsing", () => {
  it("keeps exactly well-formed snowflakes", () => {
    fc.assert(
      fc.property(fc.oneof(fc.constant(undefined), fc.string()), (raw) => {
        const parsed = parseModeratorRoleIds(raw);
        for (const id of parsed) expect(id).toMatch(/^\d{10,25}$/);
        if (raw === undefined || raw === "") expect(parsed).toEqual([]);
      }),
      OPTIONS,
    );
  });

  it("parses the documented comma list exactly", () => {
    expect(parseModeratorRoleIds(" 123456789012345 , abc, 999 ")).toEqual(["123456789012345"]);
    expect(parseModeratorRoleIds(undefined)).toEqual([]);
  });

  it("a blank allowlist fails closed for every membership", () => {
    fc.assert(
      fc.property(fc.array(fc.string()), (memberRoles) => {
        expect(isModerator(memberRoles, [])).toBe(false);
      }),
      OPTIONS,
    );
  });

  it("membership decides exactly by ID intersection, never by name", () => {
    fc.assert(
      fc.property(
        fc.array(SNOWFLAKE(), { maxLength: 5 }),
        fc.array(SNOWFLAKE(), { maxLength: 8 }),
        (allow, member) => {
          const allowSet = new Set(allow);
          expect(isModerator(member, allow)).toBe(member.some((r) => allowSet.has(r)));
          expect(isModerator(["administrators"], allow)).toBe(false);
        },
      ),
      OPTIONS,
    );
  });
});
