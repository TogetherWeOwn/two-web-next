// Acceptance: truthful RSVP prompts for guests and non-members (Kit twin).
//
// Same V1 contract as test/rsvp-truthful-prompts-acceptance.test.ts (Hono),
// rendered through the real EventDetail.svelte (svelte/compiler + esbuild SSR,
// same harness as kit-rsvp-server-clock-acceptance) with models from the real
// resolveKitEventDetail. The Builder never edits this file. Fail-first against
// d8fe53590; hermetic (fixture store only, never a real database/network).
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { build } from "esbuild";
import { beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";
import { resolveKitEventDetail, type KitEventDetailStore } from "../src/events/kit-detail";
import type { PublicEvent, ViewerRsvp } from "../src/events/reads";
import type { KitRequestSession } from "../src/kit-session";
import {
  EVENT_FULL_TESTID,
  RSVP_CLOSED_TESTID,
  RSVP_CONFIRMED_TESTID,
  RSVP_COPY,
  RSVP_GOING_TESTID,
  RSVP_PAUSED_TESTID,
  RSVP_WITHDRAW_TESTID,
  WAITLIST_CLAIM_TESTID,
  WAITLIST_JOIN_TESTID,
  WAITLIST_LEAVE_TESTID,
  WAITLIST_POSITION_TESTID,
  loginUrl,
  rsvpFullCapCopy,
} from "../src/islands/contracts";

const APP_URL = "https://next.example.test";
const KEY = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const PATH = `/e/${KEY}`;
const JOIN_HREF = `/join?next=${encodeURIComponent(PATH)}`;
const MEMBER_ID = "100000000000000001";
const NONMEMBER_ID = "100000000000000002";

const EXPECTED_GUEST_FULL_HINT = "Sign in to join the waitlist";
const EXPECTED_JOIN_TO_RSVP = "Join the server to RSVP";
const EXPECTED_GUEST_SIGNIN_TESTID = "rsvp-guest-signin";
const EXPECTED_GUEST_FULL_HINT_TESTID = "rsvp-guest-full-hint";
const EXPECTED_JOIN_SERVER_TESTID = "rsvp-join-server";

const GUEST: KitRequestSession = { status: "guest", session: null };
const memberSession: KitRequestSession = {
  status: "authenticated",
  session: { userId: MEMBER_ID, username: "member", avatar: null, member: true, moderator: false },
};
const nonMemberSession: KitRequestSession = {
  status: "authenticated",
  session: {
    userId: NONMEMBER_ID,
    username: "viewer",
    avatar: null,
    member: false,
    moderator: false,
  },
};
const moderatorSession: KitRequestSession = {
  status: "authenticated",
  session: {
    userId: MEMBER_ID,
    username: "member",
    avatar: null,
    member: true,
    moderator: true,
  },
};

function event(over: Partial<PublicEvent> = {}): PublicEvent {
  const start = new Date("2030-01-10T20:00:00Z");
  return {
    id: 7,
    icsSequence: 4n,
    eventKey: KEY,
    title: "Chess night",
    game: "Chess",
    description: "Bring a friend and a board.",
    startsAt: start,
    endsAt: new Date("2030-01-10T22:00:00Z"),
    timezone: "UTC",
    location: "The lobby",
    capacity: 10,
    status: "published",
    rsvpOpen: true,
    goingCount: 0,
    goingOccupancy: 0,
    discordEventId: null,
    discordSyncFailedAt: null,
    discordSyncFailureCode: null,
    syncRevision: 1,
    syncedRevision: 0,
    agentGrantId: null,
    proofMarker: null,
    agentVersion: 1,
    createdBy: null,
    recurrenceFrequency: null,
    recurrenceCount: null,
    recurrenceEndsOn: null,
    parentEventId: null,
    recurrenceIndex: null,
    createdAt: start,
    updatedAt: start,
    ...over,
  };
}

function store(
  ev: PublicEvent,
  answer: ViewerRsvp | null = null,
  waitlist: number | null = null,
): KitEventDetailStore {
  return {
    dbForFn: async () => ({}) as Db,
    getEventFn: async () => ev,
    neighborsFn: async () => ({ previous: null, next: null }),
    relatedFn: async () => [],
    attendeesFn: async () => [],
    viewerRsvpFn: async () => answer,
    waitlistFn: async () => waitlist,
    suggestionsFn: async () => [],
  };
}

const webRequire = createRequire(new URL("../web/package.json", import.meta.url));
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
  const worktree = fileURLToPath(new URL("../", import.meta.url));
  const scratchRoot =
    process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.PAPERCLIP_SCRATCH_DIR ?? tmpdir();
  const scratch = mkdtempSync(join(scratchRoot, "kit-rsvp-truthful-"));
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
          name: "kit-rsvp-truthful-ssr",
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
}, 120000);

async function renderOk(ev: PublicEvent, session: KitRequestSession): Promise<string> {
  const outcome = await resolveKitEventDetail({
    key: KEY,
    search: "",
    path: PATH,
    env: { APP_URL } as Env,
    session,
    joinResult: null,
    setHeaders: () => {},
    store: store(ev),
  });
  if (outcome.kind !== "ok") throw new Error(`expected ok, got ${outcome.kind}`);
  return renderDetail(outcome.model as unknown as Record<string, unknown>);
}

async function renderOkWithAnswer(
  ev: PublicEvent,
  session: KitRequestSession,
  answer: ViewerRsvp | null,
  waitlist: number | null = null,
): Promise<string> {
  const outcome = await resolveKitEventDetail({
    key: KEY,
    search: "",
    path: PATH,
    env: { APP_URL } as Env,
    session,
    joinResult: null,
    setHeaders: () => {},
    store: store(ev, answer, waitlist),
  });
  if (outcome.kind !== "ok") throw new Error(`expected ok, got ${outcome.kind}`);
  return renderDetail(outcome.model as unknown as Record<string, unknown>);
}

function mount(html: string): string {
  return /<section data-island="rsvp-button"[\s\S]*?<\/section>/.exec(html)?.[0] ?? "";
}

function dataAttrs(section: string): Record<string, string> {
  const out: Record<string, string> = {};
  const tag = /^<section[^>]*>/.exec(section)?.[0] ?? "";
  for (const m of tag.matchAll(/data-([a-z0-9-]+)="([^"]*)"/g)) {
    out[m[1]!] = m[2]!;
  }
  return out;
}

describe("acceptance: guest paused/full truth (Kit)", () => {
  it("guest on a paused event sees the paused note plus the sign-in link", async () => {
    const html = mount(await renderOk(event({ rsvpOpen: false, capacity: 10 }), GUEST));
    expect(html).toContain(`data-testid="${RSVP_PAUSED_TESTID}"`);
    // Svelte escapes the em dash entity the same bytes Hono serves.
    expect(html).toContain("RSVPs are paused for this event");
    expect(html).toContain(`href="${loginUrl(PATH)}"`);
    expect(html).toContain(RSVP_COPY.guestCta);
    expect(html).toContain(`data-testid="${EXPECTED_GUEST_SIGNIN_TESTID}"`);
    expect(html).not.toContain("/join?next=");
    expect(html).not.toContain("data-rsvp-form");
    expect(html).not.toContain("data-action");
  });

  it("guest on a full event sees the full note plus the waitlist hint", async () => {
    const html = mount(
      await renderOk(event({ rsvpOpen: true, capacity: 4, goingOccupancy: 4 }), GUEST),
    );
    expect(html).toContain('data-full="true"');
    expect(html).toContain(`data-testid="${EVENT_FULL_TESTID}"`);
    expect(html).toContain("This one");
    expect(html).toContain(rsvpFullCapCopy(4));
    expect(html).toContain(EXPECTED_GUEST_FULL_HINT);
    expect(html).toContain(`data-testid="${EXPECTED_GUEST_FULL_HINT_TESTID}"`);
    expect(html).toContain(`href="${loginUrl(PATH)}"`);
    expect(html).not.toContain("/join?next=");
    expect(html).not.toContain("data-rsvp-form");
  });

  it("guest on an open event keeps the bare sign-in link (control)", async () => {
    const html = mount(await renderOk(event({ rsvpOpen: true, capacity: null }), GUEST));
    expect(html).toContain(`href="${loginUrl(PATH)}"`);
    expect(html).toContain(RSVP_COPY.guestCta);
    expect(html).not.toContain(`data-testid="${RSVP_PAUSED_TESTID}"`);
    expect(html).not.toContain(`data-testid="${EVENT_FULL_TESTID}"`);
  });
});

describe("acceptance: signed-in non-member join path (Kit)", () => {
  it("open event links to the join landing, never a login loop", async () => {
    const html = mount(await renderOk(event({ rsvpOpen: true, capacity: null }), nonMemberSession));
    expect(html).toContain(`data-testid="${EXPECTED_JOIN_SERVER_TESTID}"`);
    expect(html).toContain(EXPECTED_JOIN_TO_RSVP);
    // Svelte escapes & in hrefs; the join href has no & so it stays byte-identical.
    expect(html).toContain(`href="${JOIN_HREF}"`);
    // Href-specific: data-login-url always carries /join/discord for recovery.
    expect(html).not.toContain('href="/join/discord');
    expect(html).not.toContain(RSVP_COPY.guestCta);
    expect(html).not.toContain("data-rsvp-form");
  });

  it("paused event still offers the join path, never the login link", async () => {
    const html = mount(await renderOk(event({ rsvpOpen: false, capacity: 10 }), nonMemberSession));
    expect(html).toContain(`href="${JOIN_HREF}"`);
    expect(html).toContain(EXPECTED_JOIN_TO_RSVP);
    expect(html).not.toContain('href="/join/discord');
  });

  it("full event still offers the join path, never the login link", async () => {
    const html = mount(
      await renderOk(event({ rsvpOpen: true, capacity: 4, goingOccupancy: 4 }), nonMemberSession),
    );
    expect(html).toContain(`href="${JOIN_HREF}"`);
    expect(html).toContain(EXPECTED_JOIN_TO_RSVP);
    expect(html).not.toContain('href="/join/discord');
  });
});

describe("acceptance: closed prompts byte-stable (Kit)", () => {
  it("moderator draft keeps the exact closed prompt", async () => {
    const html = mount(await renderOk(event({ status: "draft" }), moderatorSession));
    expect(html).toContain(`data-testid="${RSVP_CLOSED_TESTID}"`);
    expect(html).toContain("Not published yet");
    expect(html).not.toContain("data-action");
    expect(html).not.toContain('href="/join/discord');
    expect(html).not.toContain('href="/join?next=');
  });

  it("past stays closed for guest and non-member alike", async () => {
    for (const session of [GUEST, nonMemberSession]) {
      const html = mount(await renderOk(event({ status: "past" }), session));
      expect(html).toContain(`data-testid="${RSVP_CLOSED_TESTID}"`);
      expect(html).toContain("This one has been and gone");
      expect(html).not.toContain('href="/join/discord');
      expect(html).not.toContain('href="/join?next=');
    }
  });

  it("cancelled stays a gone outcome with no RSVP island", async () => {
    for (const session of [GUEST, nonMemberSession, memberSession]) {
      const outcome = await resolveKitEventDetail({
        key: KEY,
        search: "",
        path: PATH,
        env: { APP_URL } as Env,
        session,
        joinResult: null,
        setHeaders: () => {},
        store: store(event({ status: "cancelled" })),
      });
      expect(outcome.kind).toBe("gone");
      if (outcome.kind !== "gone") throw new Error("unreachable");
      expect(outcome.status).toBe(410);
      const html = renderGone(outcome.model as unknown as Record<string, unknown>);
      expect(mount(html)).toBe("");
      expect(html).not.toContain(EXPECTED_JOIN_TO_RSVP);
      expect(html).not.toContain(EXPECTED_GUEST_FULL_HINT);
    }
  });
});

describe("acceptance: member flows unchanged (Kit)", () => {
  it("going renders confirmed + withdraw, never guest/join copy", async () => {
    const html = mount(
      await renderOkWithAnswer(event({ capacity: null }), memberSession, {
        status: "going",
        syncedToDiscordAt: null,
      }),
    );
    expect(html).toContain(`data-testid="${RSVP_CONFIRMED_TESTID}"`);
    expect(html).toContain(`data-testid="${RSVP_WITHDRAW_TESTID}"`);
    expect(html).not.toContain(RSVP_COPY.guestCta);
    expect(html).not.toContain(EXPECTED_JOIN_TO_RSVP);
  });

  it("waitlisted with room renders position + claim + leave", async () => {
    const html = mount(
      await renderOkWithAnswer(event({ capacity: null }), memberSession, {
        status: "waitlisted",
        syncedToDiscordAt: null,
      }),
    );
    expect(html).toContain(`data-testid="${WAITLIST_POSITION_TESTID}"`);
    expect(html).toContain(`data-testid="${WAITLIST_CLAIM_TESTID}"`);
    expect(html).toContain(`data-testid="${WAITLIST_LEAVE_TESTID}"`);
  });

  it("full member without an answer renders full + waitlist join, never going", async () => {
    const html = mount(await renderOk(event({ capacity: 4, goingOccupancy: 4 }), memberSession));
    expect(html).toContain(`data-testid="${EVENT_FULL_TESTID}"`);
    expect(html).toContain(`data-testid="${WAITLIST_JOIN_TESTID}"`);
    expect(html).not.toContain(`data-testid="${RSVP_GOING_TESTID}"`);
  });
});

describe("acceptance: no session/token material in island attrs (Kit)", () => {
  it("the signed-in signal is a boolean-only data attr", async () => {
    const guest = mount(await renderOk(event({ capacity: null }), GUEST));
    expect(dataAttrs(guest)["signed-in"]).toBe("false");
    const outsider = mount(await renderOk(event({ capacity: null }), nonMemberSession));
    expect(dataAttrs(outsider)["signed-in"]).toBe("true");
    const member = mount(await renderOk(event({ capacity: null }), memberSession));
    expect(dataAttrs(member)["signed-in"]).toBe("true");
  });

  it("no island attr carries ids, tokens, or usernames", async () => {
    // Capacity 10 keeps data-capacity present (null omits it by design).
    for (const session of [GUEST, nonMemberSession, memberSession]) {
      const section = mount(await renderOk(event({ capacity: 10 }), session));
      const attrs = dataAttrs(section);
      for (const [k, v] of Object.entries(attrs)) {
        expect(v, `data-${k}`).not.toContain(MEMBER_ID);
        expect(v, `data-${k}`).not.toContain(NONMEMBER_ID);
        expect(v, `data-${k}`).not.toContain("member");
        expect(v, `data-${k}`).not.toContain("viewer");
        expect(v, `data-${k}`).not.toContain("eyJ");
        expect(v, `data-${k}`).not.toContain("Bearer");
      }
      expect(Object.keys(attrs).sort()).toEqual(
        ["capacity", "event-key", "full", "island", "login-url", "paused", "signed-in"].sort(),
      );
    }
  });
});

describe("acceptance: no-JS parity (Kit)", () => {
  it("non-member prompts are real anchors with no form; members keep the form", async () => {
    const guest = mount(await renderOk(event({ rsvpOpen: false, capacity: 10 }), GUEST));
    expect(guest).toMatch(/<a href="[^"]+"[^>]*>/);
    expect(guest).not.toContain("<form");
    const outsider = mount(await renderOk(event({ capacity: null }), nonMemberSession));
    expect(outsider).toMatch(/<a href="[^"]+"[^>]*>/);
    expect(outsider).not.toContain("<form");
    const member = mount(await renderOk(event({ capacity: null }), memberSession));
    expect(member).toContain('<form method="post"');
    expect(member).toContain(`${PATH}/rsvp`);
  });
});
