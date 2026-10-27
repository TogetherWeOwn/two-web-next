// route-inventory: GET /e/:key
// route-inventory: POST /e/:key/rsvp
// Acceptance: a member whose stored RSVP answer is `maybe` or `not_going`
// sees that answer on the event page instead of the join CTA, on both twins.
//
// TEST-AUTHOR OWNED. The paired Builder builds on this branch and never edits
// this file. Hermetic throughout: direct SSR renders, a compiled Kit
// presentation, the shipped island binder in a VM, and route posts against
// mocked services. No database, no network, no live probes.
//
// Contract pinned here (roadmap Q2, re-verified at HEAD c22993f44; source pin
// c6b5c5b83 shows zero drift in the cited files):
// - The write path already accepts and persists soft answers: POST accepts
//   every RSVP_STATUSES value (src/islands/contracts-rsvp-button.ts:56 via
//   isRsvpStatus), writeRsvp persists maybe/not_going as-is
//   (src/events/rsvp.ts:163-164), reads return them raw
//   (src/events/reads.ts:690-712). The bug is display-only: SSR branches
//   only on going/waitlisted (src/events/rsvp-button.tsx:59-60,110-128,
//   mirrored in web/src/lib/EventDetail.svelte:51-52), so a Maybe/Can't-go
//   member sees the join CTA as if they never answered.
// - The island binder likewise only knows going/waitlisted/withdraw: any
//   other data-action renders the failure alert and any PUT answer outside
//   going/waitlisted resolves to unknown-outcome
//   (assets/islands/rsvp-button.js onAction guard + response judge).
//
// What the Builder must ship (asserted RED below, GREEN after the fix):
// - A neutral `role=status` line naming the stored answer (Maybe / Can't-go
//   wording, Builder's copy) on both twins for member soft answers on open,
//   paused and full events — never the bare join CTA and never a
//   seat/waitlist claim (no confirmed/position/claim/full/join-position
//   status lines).
// - Change/withdraw affordances reusing the existing withdraw control
//   pattern (`button[name=status][value=withdraw]`, any testid): open events
//   offer withdraw + a going-ward change; paused events offer withdraw only
//   (a going submit while paused is a dead control — the write path 403s —
//   while withdraw always converges, including from closed events); full
//   events offer withdraw + a seat-ward change (going or waitlisted action).
// - Sync line OMITTED for soft answers (explicit, with rationale): the sync
//   copy describes seat-mirror state and the failure variant claims a held
//   spot ("your spot is still held"), which is a false seat claim for an
//   answer that holds no seat. Showing syncing/synced for soft answers would
//   either mislead or need new copy; silence is the neutral branch. The
//   omission assertions ride inside the RED soft-line tests (they fail on the
//   missing line today) and constrain the Builder against adding a sync line
//   with the new branch.
// - No-JS: the soft-branch form posts to the shared action (attendee page
//   preserved); the POST adapter already accepts soft statuses, pinned as a
//   green control (write path unchanged).
// - Island hydration preserves the soft state: no flash of join CTA, no
//   repaint on load; withdraw/change from soft converge through the existing
//   binder paint paths with the soft line removed.
// - Matrix: maybe/not_going x member/guest x open/paused/closed/full on both
//   twins. Guest and closed branches are green controls (unchanged by the
//   fix): guests never see an answer line, closed events keep their exact
//   closed copy with no soft line and no submits.
//
// Failure budget on current main (c22993f, 56 tests): 26 RED — every
// "soft answer" Hono/Kit SSR test (16), every twin-parity soft test (2) and
// every soft island test (8) FAILS (the SSR renders the CTA/full branch
// instead); all 30 controls PASS. With the fix, the whole file passes
// (proven 56/56 with a throwaway prototype, reverted). A fully-green run on
// unfixed main is a vacuous suite — reject it.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL, URL as NodeURL } from "node:url";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";
import { serializeSigned } from "hono/utils/cookie";
import { beforeAll, describe, expect, it, vi } from "vitest";
import app from "./app";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";
import { createMemorySessionStore, hashToken, newSessionToken } from "../src/sessions";
import { RsvpButton } from "../src/events/rsvp-button";
import type { PublicEvent, ViewerRsvp } from "../src/events/reads";
import { resolveKitEventDetail, type KitEventDetailStore } from "../src/events/kit-detail";
import type { KitEventDetailModel } from "../src/events/kit-detail";
import type { KitRequestSession } from "../src/kit-session";
import { dispatchRsvpSync, withdrawRsvp, writeRsvp } from "../src/events/rsvp";

// Route-post controls isolate the adapter from the store: the write path is
// out of scope (unchanged), so the services are mocked and only the adapter's
// accept + redirect shape is asserted. SSR/Kit/island sections never touch
// these mocks.
vi.mock("../src/admin/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/admin/db")>()),
  dbFor: async () => ({}) as unknown as Db,
}));
vi.mock("../src/events/rsvp", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/events/rsvp")>()),
  writeRsvp: vi.fn(),
  withdrawRsvp: vi.fn(),
  dispatchRsvpSync: async () => {},
}));

// ---------------------------------------------------------------- fixtures

const KEY = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const APP_URL = "https://next.example.test";
const PATH = `/e/${KEY}`;
const SESSION_SECRET = "test-session-secret-at-least-32-bytes-long";
const MEMBER = "420000000000000042";

const START = new Date("2030-01-10T20:00:00Z");
const END = new Date("2030-01-10T22:00:00Z");

function publicEvent(over: Partial<PublicEvent> = {}): PublicEvent {
  return {
    id: 1,
    icsSequence: 1n,
    eventKey: KEY,
    title: "Squad night",
    game: null,
    description: null,
    startsAt: START,
    endsAt: END,
    timezone: "UTC",
    location: null,
    capacity: 10,
    status: "published",
    rsvpOpen: true,
    goingCount: 1,
    goingOccupancy: 1,
    discordEventId: null,
    discordSyncFailedAt: null,
    discordSyncFailureCode: null,
    agentGrantId: null,
    proofMarker: null,
    agentVersion: 1,
    createdBy: null,
    recurrenceFrequency: null,
    recurrenceCount: null,
    recurrenceEndsOn: null,
    parentEventId: null,
    recurrenceIndex: null,
    createdAt: START,
    updatedAt: START,
    syncRevision: 1,
    syncedRevision: 0,
    ...over,
  };
}

const FULL = { capacity: 2, goingCount: 2, goingOccupancy: 2 } as const;
const PAST_END = new Date("2020-01-10T22:00:00Z");

function kitModel(over: Partial<KitEventDetailModel> = {}): KitEventDetailModel {
  return {
    eventKey: KEY,
    title: "Squad night",
    game: null,
    description: null,
    shareDescription: "Squad night",
    accessibilityNotes: null,
    location: null,
    status: "published",
    isDraft: false,
    isPast: false,
    goingCount: 1,
    goingOccupancy: 1,
    capacity: 10,
    rsvpOpen: true,
    rsvpClosed: null,
    canonical: `${APP_URL}${PATH}`,
    path: PATH,
    attendeesRefreshHref: PATH,
    robots: null,
    icsUrl: `${PATH}.ics`,
    googleCalendarUrl: null,
    directionsUrl: null,
    copyLink: `${APP_URL}${PATH}`,
    whenText: "10 January 2030",
    endsWhenText: "10 January 2030",
    zoneLabel: "UTC",
    timeDatetime: START.toISOString(),
    attendees: [],
    attendeesPaging: { page: 1, prevHref: null, nextHref: null },
    answer: null,
    waitlistPosition: null,
    neighbors: { previous: null, next: null },
    related: [],
    series: null,
    showJoinPitch: false,
    joinReturnTo: PATH,
    joinResult: null,
    viewerSignedIn: true,
    viewerMember: true,
    viewerModerator: false,
    viewerUsername: "member",
    endsAt: END.toISOString(),
    jsonLd: "{}",
    siteJsonLd: "{}",
    ...over,
  };
}

const maybeAnswer: ViewerRsvp = { status: "maybe", syncedToDiscordAt: null };
const notGoingAnswer: ViewerRsvp = { status: "not_going", syncedToDiscordAt: null };
const syncedMaybe: ViewerRsvp = {
  status: "maybe",
  syncedToDiscordAt: new Date("2030-01-01T00:00:00Z"),
};

// ---------------------------------------------------------------- matchers
//
// The Builder owns the exact soft-line copy and testids. These matchers pin
// the contract without prescribing literals: a `role=status` line naming the
// answer, no seat/waitlist/sync status claim, submits by name/value (the
// no-JS + island contract), never by new testids.

const ENTITIES: Record<string, string> = {
  "&#39;": "'",
  "&quot;": '"',
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
};
const decode = (s: string): string =>
  s.replace(/&#39;|&quot;|&amp;|&lt;|&gt;/g, (m) => ENTITIES[m]!);

function stripTags(s: string): string {
  let out = "";
  let inTag = false;
  for (const ch of s) {
    if (ch === "<") inTag = true;
    else if (ch === ">") inTag = false;
    else if (!inTag) out += ch;
  }
  return out;
}

const MAYBE_LINE = /maybe/i;
// "Can't go" or "Not going" — either naming is an honest answer line.
const NOT_GOING_LINE = /can'?t[ -]?go|not[ -]?going/i;
// Seat/waitlist/sync claims that must never describe a soft answer.
const SEAT_CLAIM = /you're in|waitlist|seat|#\d+ in line|cap is|this one's full|syncing|synced/i;

function statusLines(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<p[^>]*\brole="status"[^>]*>([\s\S]*?)<\/p>/gi)) {
    const line = decode(stripTags(m[1]!).replace(/\s+/g, " ").trim());
    // Empty live regions (the copy-link toast) carry no claim; skip them so
    // line counts compare across twins.
    if (line.length > 0) out.push(line);
  }
  return out;
}

const softLine = (html: string, which: "maybe" | "not_going"): string | null => {
  const re = which === "maybe" ? MAYBE_LINE : NOT_GOING_LINE;
  return statusLines(html).find((line) => re.test(line)) ?? null;
};

function submitValues(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<button[^>]*\bname="status"[^>]*>/gi)) {
    const tag = m[0]!;
    const value = /value="([^"]*)"/i.exec(tag)?.[1];
    if (value !== undefined) out.push(decode(value));
  }
  return out;
}

function formAction(html: string): string | null {
  // The RSVP form specifically: full-page renders carry other forms (the
  // header sign-out), so anchor on the data-rsvp-form marker the island
  // binds to, not on the first form in the document.
  const tag = html.match(/<form[^>]*\bdata-rsvp-form\b[^>]*>/i)?.[0];
  return tag?.match(/\baction="([^"]*)"/i)?.[1] ?? null;
}

function expectNoSeatClaims(html: string): void {
  for (const id of [
    "rsvp-confirmed",
    "rsvp-check",
    "waitlist-position",
    "waitlist-claim",
    "event-full",
    "rsvp-closed",
    "rsvp-paused",
  ]) {
    expect(html, `must not claim a seat/waitlist/closed state (${id})`).not.toContain(
      `data-testid="${id}"`,
    );
  }
  // No status line on the page may word a seat/waitlist/sync claim for a soft answer.
  for (const line of statusLines(html)) {
    expect(line, "status line must stay neutral for a soft answer").not.toMatch(SEAT_CLAIM);
  }
}

function expectNoSyncLine(html: string): void {
  for (const id of ["rsvp-syncing", "rsvp-synced", "rsvp-sync-failed"]) {
    expect(html, `soft answers omit the sync line (${id})`).not.toContain(`data-testid="${id}"`);
  }
}

// ---------------------------------------------------------------- Hono SSR

const hono = (props: Parameters<typeof RsvpButton>[0]): string => String(RsvpButton(props));

describe("Hono soft-answer SSR", () => {
  it.each(["maybe", "not_going"] as const)(
    "%s member on an open event sees their answer, not the join CTA",
    (status) => {
      const html = hono({
        e: publicEvent(),
        member: true,
        answer: { status, syncedToDiscordAt: null },
        returnTo: PATH,
      });
      const line = softLine(html, status);
      expect(
        line,
        `expected a role=status line naming ${status}; got: ${statusLines(html)}`,
      ).not.toBeNull();
      expect(line!).not.toMatch(SEAT_CLAIM);
      // Change/withdraw affordances on the shared no-JS form.
      expect(submitValues(html)).toContain("withdraw");
      expect(submitValues(html)).toContain("going");
      expect(submitValues(html)).not.toContain("waitlisted");
      expect(formAction(html)).toBe(`${PATH}/rsvp`);
      expectNoSeatClaims(html);
      expectNoSyncLine(html);
    },
  );

  it.each(["maybe", "not_going"] as const)(
    "%s member on a full event sees their answer, not the full/waitlist branch",
    (status) => {
      const html = hono({
        e: publicEvent({ ...FULL }),
        member: true,
        answer: { status, syncedToDiscordAt: null },
        returnTo: PATH,
      });
      expect(
        softLine(html, status),
        `expected a role=status line naming ${status}; got: ${statusLines(html)}`,
      ).not.toBeNull();
      expect(submitValues(html)).toContain("withdraw");
      // A seat-ward change (join, settling to the line) — either action word.
      expect(
        submitValues(html).filter((v) => v === "going" || v === "waitlisted"),
      ).not.toHaveLength(0);
      expectNoSeatClaims(html);
      expect(html).not.toContain('data-testid="waitlist-position"');
      expectNoSyncLine(html);
    },
  );

  it.each(["maybe", "not_going"] as const)(
    "%s member on a paused event sees paused + their answer with withdraw only",
    (status) => {
      const html = hono({
        e: publicEvent({ rsvpOpen: false }),
        member: true,
        answer: { status, syncedToDiscordAt: null },
        returnTo: PATH,
      });
      expect(html).toContain('data-testid="rsvp-paused"');
      expect(
        softLine(html, status),
        `expected a role=status line naming ${status}; got: ${statusLines(html)}`,
      ).not.toBeNull();
      expect(submitValues(html)).toContain("withdraw");
      // Change writes are refused while paused; only withdraw converges.
      expect(submitValues(html)).not.toContain("going");
      expect(submitValues(html)).not.toContain("waitlisted");
      expectNoSyncLine(html);
    },
  );

  it("soft-branch form preserves the native attendee page", () => {
    const html = hono({
      e: publicEvent(),
      member: true,
      answer: maybeAnswer,
      returnTo: `${PATH}?attendees=2`,
      attendeePage: 2,
    });
    expect(softLine(html, "maybe")).not.toBeNull();
    expect(formAction(html)).toBe(`${PATH}/rsvp?attendees=2`);
    expect(submitValues(html)).toContain("withdraw");
  });

  it.each([
    { name: "cancelled", over: { status: "cancelled" }, copy: "Cancelled" },
    { name: "draft", over: { status: "draft" }, copy: "Not published yet" },
    { name: "past", over: { endsAt: PAST_END }, copy: "This one has been and gone" },
  ] as const)("closed ($name) keeps its exact copy with no soft line", ({ over, copy }) => {
    for (const status of ["maybe", "not_going"] as const) {
      const html = hono({
        e: publicEvent({ ...over }),
        member: true,
        answer: { status, syncedToDiscordAt: null },
        returnTo: PATH,
      });
      expect(html).toContain('data-testid="rsvp-closed"');
      expect(html).toContain(copy);
      expect(softLine(html, status)).toBeNull();
      expect(submitValues(html)).toHaveLength(0);
      expectNoSyncLine(html);
    }
  });

  it.each(["open", "paused", "full", "closed"] as const)(
    "guests never see a soft-answer line (%s)",
    (state) => {
      const e =
        state === "paused"
          ? publicEvent({ rsvpOpen: false })
          : state === "full"
            ? publicEvent({ ...FULL })
            : state === "closed"
              ? publicEvent({ status: "cancelled" })
              : publicEvent();
      const html = hono({ e, member: false, answer: null, returnTo: PATH });
      expect(softLine(html, "maybe")).toBeNull();
      expect(softLine(html, "not_going")).toBeNull();
      if (state === "closed") expect(html).toContain('data-testid="rsvp-closed"');
      else if (state === "full") {
        // Full-event guests keep the waitlist-hint link, not the bare CTA.
        expect(html).toContain('data-testid="rsvp-guest-signin"');
        expect(html).toContain("Sign in to join the waitlist");
      } else expect(html).toContain("Log in with Discord");
    },
  );

  it("a soft answer never leaks through the guest branch", () => {
    // Impossible via the routes (reads only run for members) — pinned so a
    // future branch reorder cannot disclose another member's answer shape.
    const html = hono({ e: publicEvent(), member: false, answer: maybeAnswer, returnTo: PATH });
    expect(html).toContain("Log in with Discord");
    expect(softLine(html, "maybe")).toBeNull();
    expect(submitValues(html)).toHaveLength(0);
  });

  it("synced soft answers still omit the sync line", () => {
    const html = hono({ e: publicEvent(), member: true, answer: syncedMaybe, returnTo: PATH });
    expect(softLine(html, "maybe")).not.toBeNull();
    expectNoSyncLine(html);
  });
});

describe("Hono established branches are unchanged", () => {
  it("going still confirms with withdraw + sync line", () => {
    const html = hono({
      e: publicEvent(),
      member: true,
      answer: { status: "going", syncedToDiscordAt: null },
      returnTo: PATH,
    });
    expect(html).toContain('data-testid="rsvp-confirmed"');
    expect(statusLines(html).some((l) => l.includes("You're in"))).toBe(true);
    expect(submitValues(html)).toContain("withdraw");
    expect(html).toContain('data-testid="rsvp-syncing"');
    expect(softLine(html, "maybe")).toBeNull();
  });

  it("waitlisted still shows position with claim + leave", () => {
    const html = hono({
      e: publicEvent(),
      member: true,
      answer: { status: "waitlisted", syncedToDiscordAt: null },
      returnTo: PATH,
      waitlistPosition: 3,
    });
    expect(html).toContain('data-testid="waitlist-position"');
    expect(html).toContain("#3 in line");
    expect(submitValues(html)).toContain("going");
    expect(submitValues(html)).toContain("withdraw");
  });

  it("unanswered members still get the bare join CTA", () => {
    const html = hono({ e: publicEvent(), member: true, answer: null, returnTo: PATH });
    expect(html).toContain('data-testid="rsvp-going"');
    expect(submitValues(html)).toEqual(["going"]);
    expect(softLine(html, "maybe")).toBeNull();
    expect(softLine(html, "not_going")).toBeNull();
  });

  it("unanswered members on a full event still get full + waitlist join", () => {
    const html = hono({ e: publicEvent({ ...FULL }), member: true, answer: null, returnTo: PATH });
    expect(html).toContain('data-testid="event-full"');
    expect(html).toContain('data-testid="waitlist-join"');
    expect(submitValues(html)).toEqual(["waitlisted"]);
  });

  it("paused events without an answer still show only the paused notice", () => {
    const html = hono({
      e: publicEvent({ rsvpOpen: false }),
      member: true,
      answer: null,
      returnTo: PATH,
    });
    expect(html).toContain('data-testid="rsvp-paused"');
    expect(submitValues(html)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------- Kit SSR

// Same SSR recipe as kit-rsvp-server-clock-acceptance.test.ts: the real
// resolver contract plus the real compiled Svelte presentation.
const webRequire = createRequire(new NodeURL("../web/package.json", import.meta.url));
const { compile } = webRequire("svelte/compiler") as {
  compile: (
    source: string,
    options: { generate: string; dev: boolean; filename: string },
  ) => { js: { code: string } };
};
type Renderer = (model: Record<string, unknown>) => string;
let renderDetail: Renderer;
let renderGone: Renderer;

beforeAll(async () => {
  const worktree = fileURLToPath(new NodeURL("../", import.meta.url));
  const scratchRoot =
    process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.PAPERCLIP_SCRATCH_DIR ?? tmpdir();
  const scratch = mkdtempSync(join(scratchRoot, "kit-soft-answer-"));
  try {
    const entry = join(scratch, "entry.mjs");
    writeFileSync(
      entry,
      `
import { render } from "svelte/server";
import Detail from ${JSON.stringify(join(worktree, "web/src/lib/EventDetail.svelte"))};
import Gone from ${JSON.stringify(join(worktree, "web/src/lib/EventGone.svelte"))};
export function renderDetail(model) {
  return render(Detail, { props: { model } }).body;
}
export function renderGone(model) {
  return render(Gone, { props: { model } }).body;
}
`,
    );
    const outfile = join(scratch, "bundle.mjs");
    await build({
      entryPoints: [entry],
      bundle: true,
      platform: "node",
      format: "esm",
      outfile,
      logLevel: "warning",
      absWorkingDir: worktree,
      nodePaths: [join(worktree, "web/node_modules"), join(worktree, "node_modules")],
      alias: { "#lib": join(worktree, "web/src/lib") },
      plugins: [
        {
          name: "kit-soft-answer-ssr",
          setup(plugin) {
            plugin.onLoad({ filter: /\.svelte$/ }, (args) => {
              const { js } = compile(readFileSync(args.path, "utf8"), {
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
    ({ renderDetail, renderGone } = (await import(pathToFileURL(outfile).href)) as {
      renderDetail: Renderer;
      renderGone: Renderer;
    });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

const kit = (over: Partial<KitEventDetailModel> = {}): string =>
  renderDetail(kitModel(over) as unknown as Record<string, unknown>);

describe("Kit soft-answer SSR", () => {
  it.each(["maybe", "not_going"] as const)(
    "%s member on an open event sees their answer, not the join CTA",
    (status) => {
      const html = kit({ answer: { status, syncedToDiscordAt: null } });
      const line = softLine(html, status);
      expect(
        line,
        `expected a role=status line naming ${status}; got: ${statusLines(html)}`,
      ).not.toBeNull();
      expect(line!).not.toMatch(SEAT_CLAIM);
      expect(submitValues(html)).toContain("withdraw");
      expect(submitValues(html)).toContain("going");
      expect(submitValues(html)).not.toContain("waitlisted");
      expect(formAction(html)).toBe(`${PATH}/rsvp`);
      expectNoSeatClaims(html);
      expectNoSyncLine(html);
    },
  );

  it.each(["maybe", "not_going"] as const)(
    "%s member on a full event sees their answer, not the full/waitlist branch",
    (status) => {
      const html = kit({ ...FULL, answer: { status, syncedToDiscordAt: null } });
      expect(
        softLine(html, status),
        `expected a role=status line naming ${status}; got: ${statusLines(html)}`,
      ).not.toBeNull();
      expect(submitValues(html)).toContain("withdraw");
      expect(
        submitValues(html).filter((v) => v === "going" || v === "waitlisted"),
      ).not.toHaveLength(0);
      expectNoSeatClaims(html);
      expectNoSyncLine(html);
    },
  );

  it.each(["maybe", "not_going"] as const)(
    "%s member on a paused event sees paused + their answer with withdraw only",
    (status) => {
      const html = kit({ rsvpOpen: false, answer: { status, syncedToDiscordAt: null } });
      expect(html).toContain('data-testid="rsvp-paused"');
      expect(
        softLine(html, status),
        `expected a role=status line naming ${status}; got: ${statusLines(html)}`,
      ).not.toBeNull();
      expect(submitValues(html)).toContain("withdraw");
      expect(submitValues(html)).not.toContain("going");
      expect(submitValues(html)).not.toContain("waitlisted");
      expectNoSyncLine(html);
    },
  );

  it("soft-branch form preserves the native attendee page", () => {
    const html = kit({
      answer: maybeAnswer,
      attendeesPaging: { page: 2, prevHref: PATH, nextHref: null },
    });
    expect(softLine(html, "maybe")).not.toBeNull();
    expect(formAction(html)).toBe(`${PATH}/rsvp?attendees=2`);
    expect(submitValues(html)).toContain("withdraw");
  });

  it.each([
    { name: "draft", over: { rsvpClosed: "draft", isDraft: true }, copy: "Not published yet" },
    {
      name: "past",
      over: { rsvpClosed: "past", isPast: true },
      copy: "This one has been and gone",
    },
  ] as const)("closed ($name) keeps its exact copy with no soft line", ({ over, copy }) => {
    for (const status of ["maybe", "not_going"] as const) {
      const html = kit({ ...over, answer: { status, syncedToDiscordAt: null } });
      expect(html).toContain('data-testid="rsvp-closed"');
      expect(html).toContain(copy);
      expect(softLine(html, status)).toBeNull();
      expect(submitValues(html)).toHaveLength(0);
    }
  });

  it.each(["open", "paused", "full", "closed"] as const)(
    "guests never see a soft-answer line (%s)",
    (state) => {
      const over: Partial<KitEventDetailModel> =
        state === "paused"
          ? { rsvpOpen: false }
          : state === "full"
            ? { ...FULL }
            : state === "closed"
              ? { rsvpClosed: "past", isPast: true }
              : {};
      const html = kit({
        ...over,
        answer: null,
        viewerSignedIn: false,
        viewerMember: false,
        viewerUsername: null,
        showJoinPitch: true,
      });
      expect(softLine(html, "maybe")).toBeNull();
      expect(softLine(html, "not_going")).toBeNull();
      if (state === "closed") expect(html).toContain('data-testid="rsvp-closed"');
      else if (state === "full") {
        // Full-event guests keep the waitlist-hint link, not the bare CTA.
        expect(html).toContain('data-testid="rsvp-guest-signin"');
        expect(html).toContain("Sign in to join the waitlist");
      } else expect(html).toContain("Log in with Discord");
    },
  );

  it("synced soft answers still omit the sync line", () => {
    const html = kit({ answer: syncedMaybe });
    expect(softLine(html, "maybe")).not.toBeNull();
    expectNoSyncLine(html);
  });
});

describe("Kit established branches are unchanged", () => {
  it("going still confirms with withdraw + sync line", () => {
    const html = kit({ answer: { status: "going", syncedToDiscordAt: null } });
    expect(html).toContain('data-testid="rsvp-confirmed"');
    expect(submitValues(html)).toContain("withdraw");
    expect(html).toContain('data-testid="rsvp-syncing"');
  });

  it("unanswered members still get the bare join CTA", () => {
    const html = kit({ answer: null });
    expect(html).toContain('data-testid="rsvp-going"');
    expect(submitValues(html)).toEqual(["going"]);
    expect(softLine(html, "maybe")).toBeNull();
  });

  it("cancelled events render the gone page with no RSVP island", async () => {
    const outcome = await resolveKitEventDetail({
      key: KEY,
      search: "",
      path: PATH,
      env: { APP_URL } as Env,
      session: kitMember,
      joinResult: null,
      setHeaders: () => {},
      store: softStore(notGoingAnswer, { status: "cancelled" }),
    });
    expect(outcome.kind).toBe("gone");
    if (outcome.kind !== "gone") throw new Error("expected gone");
    const html = renderGone(outcome.model as unknown as Record<string, unknown>);
    expect(html).toContain('data-testid="event-cancelled"');
    expect(html).not.toContain('data-island="rsvp-button"');
  });
});

// ---------------------------------------------------------------- twin parity

describe("twin parity for soft answers", () => {
  it.each(["maybe", "not_going"] as const)("both twins name the %s answer", (status) => {
    const honoHtml = hono({
      e: publicEvent(),
      member: true,
      answer: { status, syncedToDiscordAt: null },
      returnTo: PATH,
    });
    const kitHtml = kit({ answer: { status, syncedToDiscordAt: null } });
    expect(softLine(honoHtml, status)).not.toBeNull();
    expect(softLine(kitHtml, status)).not.toBeNull();
  });

  it.each([
    {
      name: "draft",
      honoOver: { status: "draft" },
      kitOver: { rsvpClosed: "draft", isDraft: true },
    },
    { name: "past", honoOver: { endsAt: PAST_END }, kitOver: { rsvpClosed: "past", isPast: true } },
  ] as const)("closed ($name) copy is byte-identical across twins", ({ honoOver, kitOver }) => {
    const honoHtml = hono({
      e: publicEvent({ ...honoOver }),
      member: true,
      answer: maybeAnswer,
      returnTo: PATH,
    });
    const kitHtml = kit({ ...kitOver, answer: notGoingAnswer });
    // Same closed verdict, same words, no answer line on either twin.
    expect(statusLines(honoHtml)).toHaveLength(1);
    expect(statusLines(kitHtml)).toHaveLength(1);
    expect(statusLines(kitHtml)[0]).toBe(statusLines(honoHtml)[0]);
    expect(softLine(honoHtml, "maybe")).toBeNull();
    expect(softLine(kitHtml, "not_going")).toBeNull();
  });
});

// ---------------------------------------------------------------- resolver chain

function softStore(
  answer: ViewerRsvp | null,
  over: Partial<PublicEvent> = {},
): KitEventDetailStore {
  const start = new Date("2030-01-10T20:00:00Z");
  const row = {
    ...publicEvent(),
    startsAt: start,
    endsAt: END,
    createdAt: start,
    updatedAt: start,
    ...over,
  };
  return {
    dbForFn: async () => ({}) as Db,
    getEventFn: async () => row,
    neighborsFn: async () => ({ previous: null, next: null }),
    relatedFn: async () => [],
    attendeesFn: async () => [],
    viewerRsvpFn: async () => answer,
    waitlistFn: async () => null,
    suggestionsFn: async () => [],
  };
}

const kitMember: KitRequestSession = {
  status: "authenticated",
  session: { userId: MEMBER, username: "member", avatar: null, member: true, moderator: false },
};

describe("Kit resolver carries soft answers to the model", () => {
  it.each(["maybe", "not_going"] as const)(
    "model.answer is %s (control: already passes)",
    async (status) => {
      const outcome = await resolveKitEventDetail({
        key: KEY,
        search: "",
        path: PATH,
        env: { APP_URL } as Env,
        session: kitMember,
        joinResult: null,
        setHeaders: () => {},
        store: softStore({ status, syncedToDiscordAt: null }),
      });
      expect(outcome.kind).toBe("ok");
      if (outcome.kind !== "ok") throw new Error("expected ok");
      expect(outcome.model.answer?.status).toBe(status);
      expect(outcome.model.rsvpClosed).toBeNull();
    },
  );
});

// ---------------------------------------------------------------- no-JS POST adapter

const postStore = createMemorySessionStore();
const postEnv = {
  APP_URL,
  SESSION_SECRET,
  SESSION_STORE: postStore,
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: "326474832151838730",
  DISCORD_INVITE_URL: "https://discord.gg/invite",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
} as unknown as Env;

async function memberCookie(): Promise<string> {
  const token = newSessionToken();
  await postStore.create({
    tokenHash: await hashToken(token),
    userId: MEMBER,
    username: "member",
    avatar: null,
    member: true,
    moderator: false,
    expiresAt: new Date(Date.now() + 3600_000),
  });
  return (
    await serializeSigned("__Host-two_session", token, SESSION_SECRET, {
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "Lax",
    })
  ).split(";")[0]!;
}

function okWrite(status: string) {
  return {
    ok: true as const,
    created: false,
    answer: { status: status as "maybe", syncedToDiscordAt: null, waitlistPosition: null },
    mirrored: "published" as const,
    eventKey: KEY,
  };
}

describe("no-JS POST adapter accepts soft answers (controls: write path unchanged)", () => {
  it.each(["maybe", "not_going"] as const)(
    "POST status=%s answers 303 to the event page",
    async (status) => {
      vi.mocked(writeRsvp).mockResolvedValueOnce(okWrite(status));
      const res = await app.request(
        `${PATH}/rsvp`,
        {
          method: "POST",
          headers: {
            cookie: await memberCookie(),
            origin: APP_URL,
            "content-type": "application/x-www-form-urlencoded",
          },
          body: `status=${status}`,
        },
        postEnv,
      );
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe(PATH);
      expect(vi.mocked(writeRsvp)).toHaveBeenCalledWith(expect.anything(), KEY, MEMBER, status);
      expect(dispatchRsvpSync).toBeDefined();
    },
  );

  it("POST withdraw from a soft answer converges to the event page", async () => {
    vi.mocked(withdrawRsvp).mockResolvedValueOnce({
      limited: false,
      deleted: true,
      status: "published",
    });
    const res = await app.request(
      `${PATH}/rsvp`,
      {
        method: "POST",
        headers: {
          cookie: await memberCookie(),
          origin: APP_URL,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: "status=withdraw",
      },
      postEnv,
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(PATH);
    expect(vi.mocked(withdrawRsvp)).toHaveBeenCalledWith(expect.anything(), KEY, MEMBER);
  });
});

// ---------------------------------------------------------------- island hydration

// Execute the shipped binder without a browser, network or database — the
// same fixture-DOM recipe as islands-rsvp-binder.test.ts, fed with the REAL
// SSR for soft answers so a wrong SSR fails here too (no hand-made markup
// that could pass while the page stays broken).
const binder = readFileSync(
  new NodeURL("../public/islands/rsvp-button.js", import.meta.url),
  "utf8",
);

class Node {
  children: Node[] = [];
  parentNode: Node | null = null;
  attributes = new Map<string, string>();
  disabled = false;
  focused = false;
  private text = "";
  listeners = new Map<string, (e: { preventDefault: () => void }) => void>();
  get textContent(): string {
    return this.text + this.children.map((n) => n.textContent).join("");
  }
  set textContent(value: string) {
    this.text = value;
    this.children = [];
  }
  setAttribute(k: string, v: string) {
    this.attributes.set(k, String(v));
  }
  getAttribute(k: string) {
    return this.attributes.get(k) ?? null;
  }
  removeAttribute(k: string) {
    this.attributes.delete(k);
  }
  appendChild(n: Node) {
    n.parentNode?.removeChild(n);
    n.parentNode = this;
    this.children.push(n);
    return n;
  }
  insertBefore(n: Node, anchor: Node | null) {
    if (anchor === null) return this.appendChild(n);
    if (!this.children.includes(anchor)) throw new Error("anchor is not a child");
    if (n === anchor) return n;
    n.parentNode?.removeChild(n);
    n.parentNode = this;
    this.children.splice(this.children.indexOf(anchor), 0, n);
    return n;
  }
  remove() {
    this.parentNode?.removeChild(this);
  }
  removeChild(n: Node) {
    this.children = this.children.filter((child) => child !== n);
    n.parentNode = null;
  }
  replaceChild(next: Node, old: Node) {
    this.children[this.children.indexOf(old)] = next;
    next.parentNode = this;
    old.parentNode = null;
  }
  focus() {
    this.focused = true;
  }
  contains(node: Node | null): boolean {
    for (let n = node; n; n = n.parentNode) if (n === this) return true;
    return false;
  }
  addEventListener(type: string, fn: (e: { preventDefault: () => void }) => void) {
    this.listeners.set(type, fn);
  }
  click() {
    if (!this.disabled) this.listeners.get("click")?.({ preventDefault() {} });
  }
  querySelectorAll(selector: string): Node[] {
    const matches = (n: Node) =>
      selector.split(",").some((s) => {
        const m = /^\[([^=\]]+)(?:="([^"]*)")?\]$/.exec(s.trim());
        return m
          ? m[2] === undefined
            ? n.attributes.has(m[1]!)
            : n.getAttribute(m[1]!) === m[2]
          : false;
      });
    return this.children.flatMap((n) => [
      ...(matches(n) ? [n] : []),
      ...n.querySelectorAll(selector),
    ]);
  }
  querySelector(selector: string) {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}

function parse(html: string): Node {
  const page = new Node();
  const stack = [page];
  for (const token of html.match(/<[^>]*>|[^<]+/g) ?? []) {
    if (token.startsWith("</")) {
      stack.pop();
      continue;
    }
    if (token.startsWith("<!")) continue;
    const n = new Node();
    stack[stack.length - 1]!.appendChild(n);
    if (!token.startsWith("<")) {
      n.textContent = decode(token);
      continue;
    }
    for (const [, key, value] of token.matchAll(/\s([\w-]+)(?:="([^"]*)")?/g))
      n.setAttribute(key!, decode(value ?? ""));
    if (!/^<(?:meta|link|input|br)\b/.test(token)) stack.push(n);
  }
  return page;
}

type SoftState = "open" | "paused" | "full";

function hydrate(status: "maybe" | "not_going" | null, state: SoftState = "open") {
  const e =
    state === "paused"
      ? publicEvent({ rsvpOpen: false })
      : state === "full"
        ? publicEvent({ ...FULL })
        : publicEvent();
  const html = hono({
    e,
    member: true,
    answer: status ? { status, syncedToDiscordAt: null } : null,
    returnTo: PATH,
  });
  const page = parse(html);
  const root = page.querySelector('[data-island="rsvp-button"]')!;
  const requests: { url: string; init: RequestInit; resolve: (r: Response) => void }[] = [];
  const broadcasts: { type: string; detail: unknown }[] = [];
  const listeners = new Map<string, (event: { type: string; detail: unknown }) => void>();
  const context = {
    document: {
      querySelector: (s: string) => page.querySelector(s),
      querySelectorAll: (s: string) => page.querySelectorAll(s),
      createElement: () => new Node(),
      createTextNode: (text: string) => {
        const n = new Node();
        n.textContent = text;
        return n;
      },
      addEventListener: (type: string, fn: (event: { type: string; detail: unknown }) => void) =>
        listeners.set(type, fn),
      dispatchEvent: (event: { type: string; detail: unknown }) => {
        broadcasts.push(event);
        listeners.get(event.type)?.(event);
      },
    },
    CustomEvent: class {
      constructor(
        public type: string,
        public options: { detail: unknown },
      ) {}
      get detail() {
        return this.options.detail;
      }
    },
    location: { pathname: PATH, reload: () => {} },
    fetch: (url: string, init: RequestInit) =>
      new Promise<Response>((resolve) => requests.push({ url, init, resolve })),
    setTimeout: ((callback: () => void) => 0) as unknown as typeof setTimeout,
    clearTimeout: (() => {}) as unknown as typeof clearTimeout,
  };
  runInNewContext(binder, context);
  const liveSoft = (which: "maybe" | "not_going"): Node | null => {
    const re = which === "maybe" ? MAYBE_LINE : NOT_GOING_LINE;
    return root.querySelectorAll('[role="status"]').find((n) => re.test(n.textContent)) ?? null;
  };
  return {
    root,
    html,
    requests,
    broadcasts,
    liveSoft,
    listeners,
    refresh: (detail: unknown) =>
      context.document.dispatchEvent({ type: "going-count-refreshed", detail }),
    get: (id: string) => root.querySelector(`[data-testid="${id}"]`),
    action: (value: string) => root.querySelector(`[data-action="${value}"]`),
    settle: async () => {
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

describe("island hydration preserves soft answers (no CTA flash)", () => {
  it.each(["maybe", "not_going"] as const)(
    "hydrating %s keeps the answer line, fires nothing",
    (status) => {
      const b = hydrate(status);
      // The SSR string itself must carry the line — a hand-made fixture would
      // hide a broken server render.
      expect(softLine(b.html, status)).not.toBeNull();
      const live = b.liveSoft(status);
      expect(live, "hydration must preserve the soft-answer line").not.toBeNull();
      expect(live!.textContent).not.toMatch(SEAT_CLAIM);
      expect(b.requests).toHaveLength(0);
      expect(b.get("rsvp-confirmed")).toBeNull();
      expect(b.get("waitlist-position")).toBeNull();
      expect(b.get("event-full")).toBeNull();
      expect(b.action("withdraw")).not.toBeNull();
      expect(b.action("going")).not.toBeNull();
    },
  );

  it.each(["maybe", "not_going"] as const)(
    "hydrating paused %s keeps paused + answer",
    (status) => {
      const b = hydrate(status, "paused");
      expect(softLine(b.html, status)).not.toBeNull();
      expect(b.liveSoft(status)).not.toBeNull();
      expect(b.get("rsvp-paused")).not.toBeNull();
      expect(b.action("withdraw")).not.toBeNull();
      expect(b.action("going")).toBeNull();
      expect(b.action("waitlisted")).toBeNull();
      expect(b.requests).toHaveLength(0);
    },
  );

  it.each(["maybe", "not_going"] as const)(
    "hydrating full %s keeps the answer, not the full branch",
    (status) => {
      const b = hydrate(status, "full");
      expect(softLine(b.html, status)).not.toBeNull();
      expect(b.liveSoft(status)).not.toBeNull();
      expect(b.get("event-full")).toBeNull();
      expect(b.action("withdraw")).not.toBeNull();
      expect(b.requests).toHaveLength(0);
    },
  );

  it.each(["maybe", "not_going"] as const)(
    "capacity refresh to full keeps %s without the unanswered full notice",
    (status) => {
      const b = hydrate(status);
      const line = b.liveSoft(status);
      expect(line).not.toBeNull();
      expect(b.action("going")).not.toBeNull();
      expect(b.listeners.has("going-count-refreshed")).toBe(true);
      b.refresh({ eventKey: KEY, goingCount: 1, goingOccupancy: 2, capacity: 2 });
      expect(b.root.getAttribute("data-full")).toBe("true");
      expect(b.liveSoft(status)).toBe(line);
      expect(line!.textContent).not.toMatch(SEAT_CLAIM);
      expect(b.get("event-full")).toBeNull();
      expect(b.root.querySelectorAll('[data-testid="waitlist-join"]')).toHaveLength(1);
      expect(b.get("waitlist-join")!.getAttribute("data-action")).toBe("waitlisted");
      expect(b.get("waitlist-join")!.getAttribute("value")).toBe("waitlisted");
      expect(b.get("rsvp-going")).toBeNull();
      expect(b.action("going")).toBeNull();
      expect(b.action("withdraw")).not.toBeNull();
      expect(b.requests).toHaveLength(0);
    },
  );

  it("capacity refresh to full paints the unanswered full notice (control)", () => {
    const b = hydrate(null);
    expect(b.get("event-full")).toBeNull();
    expect(b.action("going")).not.toBeNull();
    expect(b.listeners.has("going-count-refreshed")).toBe(true);
    b.refresh({ eventKey: KEY, goingCount: 1, goingOccupancy: 2, capacity: 2 });
    expect(b.root.getAttribute("data-full")).toBe("true");
    expect(b.get("event-full")?.textContent).toContain("Cap is 2.");
    expect(b.root.querySelectorAll('[data-testid="waitlist-join"]')).toHaveLength(1);
    expect(b.get("rsvp-going")).toBeNull();
    expect(b.liveSoft("maybe")).toBeNull();
    expect(b.liveSoft("not_going")).toBeNull();
    expect(b.requests).toHaveLength(0);
  });

  it.each(["maybe", "not_going"] as const)(
    "settling %s as waitlisted replaces the soft answer with the real position",
    async (status) => {
      const b = hydrate(status, "full");
      expect(b.liveSoft(status)).not.toBeNull();
      expect(b.get("event-full")).toBeNull();
      expect(b.get("waitlist-position")).toBeNull();
      const join = b.action("waitlisted");
      expect(join).not.toBeNull();
      join!.click();
      expect(b.requests).toHaveLength(1);
      expect(b.requests[0]!.url).toBe(`/events/${KEY}/rsvp`);
      expect(b.requests[0]!.init.method).toBe("PUT");
      expect(b.requests[0]!.init.body).toBe('{"status":"waitlisted"}');
      b.requests[0]!.resolve(
        new Response(
          JSON.stringify({
            data: { status: "waitlisted", waitlist_position: 3, synced_to_discord_at: null },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
      await b.settle();
      expect(b.get("rsvp-maybe")).toBeNull();
      expect(b.get("rsvp-not-going")).toBeNull();
      expect(b.liveSoft(status)).toBeNull();
      expect(b.root.querySelectorAll('[data-testid="waitlist-position"]')).toHaveLength(1);
      expect(b.get("waitlist-position")!.textContent).toBe("You're on the waitlist — #3 in line");
      expect(b.root.querySelectorAll('[data-testid="waitlist-leave"]')).toHaveLength(1);
      expect(b.root.querySelectorAll("[data-action]")).toHaveLength(1);
      expect(b.action("withdraw")).not.toBeNull();
      expect(b.get("rsvp-withdraw")).toBeNull();
      expect(b.get("waitlist-join")).toBeNull();
      expect(b.get("rsvp-going")).toBeNull();
      expect(b.get("rsvp-confirmed")).toBeNull();
      expect(b.get("event-full")).toBeNull();
      expect(
        b.broadcasts.map((e) => (e.detail as { viewerState?: string })?.viewerState),
      ).toContain("waitlisted");
      expect(b.requests).toHaveLength(1);
    },
  );

  it.each([
    ["maybe", "open"],
    ["maybe", "full"],
    ["not_going", "open"],
    ["not_going", "full"],
  ] as const)(
    "withdrawal from %s on %s leaves exactly one replacement control",
    async (status, state) => {
      const b = hydrate(status, state);
      expect(b.liveSoft(status)).not.toBeNull();
      const withdraw = b.action("withdraw");
      expect(withdraw, "soft branch must offer withdraw").not.toBeNull();
      withdraw!.click();
      expect(b.requests).toHaveLength(1);
      expect(b.requests[0]!.url).toBe(`/events/${KEY}/rsvp`);
      expect(b.requests[0]!.init.method).toBe("DELETE");
      expect(b.requests[0]!.init.body).toBeUndefined();
      b.requests[0]!.resolve(new Response(null, { status: 204 }));
      await b.settle();
      expect(b.get("rsvp-maybe")).toBeNull();
      expect(b.get("rsvp-not-going")).toBeNull();
      expect(b.liveSoft(status)).toBeNull();
      expect(b.action("withdraw")).toBeNull();
      expect(b.get("rsvp-withdraw")).toBeNull();
      expect(b.root.querySelectorAll('[data-testid="rsvp-going"]')).toHaveLength(
        state === "open" ? 1 : 0,
      );
      expect(b.root.querySelectorAll('[data-testid="waitlist-join"]')).toHaveLength(
        state === "full" ? 1 : 0,
      );
      expect(b.root.querySelectorAll("[data-action]")).toHaveLength(1);
      expect(b.action(state === "open" ? "going" : "waitlisted")).not.toBeNull();
      expect(b.action(state === "open" ? "waitlisted" : "going")).toBeNull();
      expect(b.get("rsvp-confirmed")).toBeNull();
      expect(b.get("waitlist-position")).toBeNull();
      expect(
        b.broadcasts.map((e) => (e.detail as { viewerState?: string })?.viewerState),
      ).toContain("none");
      expect(b.requests).toHaveLength(1);
    },
  );

  it("withdraw from maybe converges to the join CTA with no broadcast seat", async () => {
    const b = hydrate("maybe");
    expect(b.liveSoft("maybe")).not.toBeNull();
    const withdraw = b.action("withdraw");
    expect(withdraw, "soft branch must offer withdraw").not.toBeNull();
    withdraw!.click();
    expect(b.requests).toHaveLength(1);
    expect(b.requests[0]!.init.method).toBe("DELETE");
    b.requests[0]!.resolve(new Response(null, { status: 204 }));
    await b.settle();
    expect(b.liveSoft("maybe")).toBeNull();
    expect(b.action("going")).not.toBeNull();
    expect(b.broadcasts.map((e) => (e.detail as { viewerState?: string })?.viewerState)).toContain(
      "none",
    );
  });

  it("change to going from not_going confirms and drops the soft line", async () => {
    const b = hydrate("not_going");
    expect(b.liveSoft("not_going")).not.toBeNull();
    const going = b.action("going");
    expect(going, "open soft branch must offer a going-ward change").not.toBeNull();
    going!.click();
    expect(b.requests).toHaveLength(1);
    expect(b.requests[0]!.init.method).toBe("PUT");
    b.requests[0]!.resolve(
      new Response(JSON.stringify({ data: { status: "going", synced_to_discord_at: null } }), {
        status: 200,
      }),
    );
    await b.settle();
    expect(b.get("rsvp-confirmed")).not.toBeNull();
    expect(b.liveSoft("not_going")).toBeNull();
    expect(b.broadcasts.map((e) => (e.detail as { viewerState?: string })?.viewerState)).toContain(
      "going",
    );
    expect(b.get("rsvp-confirmed")!.focused).toBe(true);
  });

  it("unanswered hydration keeps the bare CTA and fires nothing (control)", () => {
    const b = hydrate(null);
    expect(b.action("going")).not.toBeNull();
    expect(b.liveSoft("maybe")).toBeNull();
    expect(b.liveSoft("not_going")).toBeNull();
    expect(b.requests).toHaveLength(0);
  });
});
