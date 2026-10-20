// route-inventory: GET /e/:key
// Acceptance: resolve under the server clock, then render the real Kit
// presentation under a different viewer clock. Recomputing closure in the
// presentation must not reopen an ended event or close a still-open one.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { build } from "esbuild";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";
import { resolveKitEventDetail, type KitEventDetailStore } from "../src/events/kit-detail";
import type { PublicEvent } from "../src/events/reads";
import type { KitRequestSession } from "../src/kit-session";

const APP_URL = "https://next.example.test";
const KEY = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const PATH = `/e/${KEY}`;
const BEFORE_END = "2030-01-10T21:59:59.999Z";
const AT_END = "2030-01-10T22:00:00.000Z";
const AFTER_END = "2030-01-10T22:00:00.001Z";

function event(status: PublicEvent["status"]): PublicEvent {
  const start = new Date("2030-01-10T20:00:00Z");
  return {
    id: 7,
    icsSequence: 4n,
    eventKey: KEY,
    title: "Chess night",
    game: "Chess",
    ...{ purpose: null },
    description: "Bring a friend and a board.",
    startsAt: start,
    endsAt: new Date(AT_END),
    timezone: "UTC",
    location: "The lobby",
    capacity: 10,
    status,
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
  };
}

// Only external reads are fixtures: the resolver and Svelte component are
// real. An unanswered member and spare capacity isolate time from RSVP state.
function store(status: PublicEvent["status"]): KitEventDetailStore {
  return {
    dbForFn: async () => ({}) as Db,
    getEventFn: async () => event(status),
    neighborsFn: async () => ({ previous: null, next: null }),
    relatedFn: async () => [],
    attendeesFn: async () => [],
    viewerRsvpFn: async () => null,
    waitlistFn: async () => null,
    suggestionsFn: async () => [],
  };
}

const member: KitRequestSession = {
  status: "authenticated",
  session: {
    userId: "100000000000000001",
    username: "member",
    avatar: null,
    member: true,
    moderator: false,
  },
};

// Same SSR recipe as kit-event-detail.test.ts; compile before faking Date.
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
  const scratch = mkdtempSync(join(scratchRoot, "kit-rsvp-clock-"));
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
          name: "kit-rsvp-clock-ssr",
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

afterEach(() => vi.useRealTimers());

async function renderAt(
  serverNow: string,
  viewerNow: string,
  status: PublicEvent["status"] = "published",
) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(serverNow));
  const session =
    status === "draft" ? { ...member, session: { ...member.session!, moderator: true } } : member;
  const outcome = await resolveKitEventDetail({
    key: KEY,
    search: "",
    path: PATH,
    env: { APP_URL } as Env,
    session,
    joinResult: null,
    setHeaders: () => {},
    store: store(status),
  });
  // The resolved model crosses the server/viewer boundary unchanged. No new
  // clock seam or model field is prescribed to the paired implementation.
  vi.setSystemTime(new Date(viewerNow));
  if (outcome.kind === "ok") {
    return {
      kind: outcome.kind,
      html: renderDetail(outcome.model as unknown as Record<string, unknown>),
    };
  }
  if (outcome.kind === "gone") {
    return {
      kind: outcome.kind,
      html: renderGone(outcome.model as unknown as Record<string, unknown>),
    };
  }
  throw new Error(`expected event presentation, got ${outcome.kind}`);
}

function expectNoRsvpAction(html: string) {
  expect(html).not.toContain('data-testid="rsvp-going"');
  expect(html).not.toContain('data-testid="waitlist-join"');
  expect(html).not.toContain('data-testid="rsvp-withdraw"');
  expect(html).not.toContain(`action="${PATH}/rsvp"`);
}

describe("Kit RSVP closure uses the server render clock", () => {
  it.each([
    { name: "a slow viewer cannot reopen an ended event", server: AFTER_END, viewer: BEFORE_END },
    { name: "the exact server end instant is closed", server: AT_END, viewer: BEFORE_END },
    {
      name: "an ended event stays closed with matching clocks",
      server: AFTER_END,
      viewer: AFTER_END,
    },
  ])("$name", async ({ server, viewer }) => {
    const { kind, html } = await renderAt(server, viewer);
    expect(kind).toBe("ok");
    expect(html).toContain('data-testid="rsvp-closed"');
    expectNoRsvpAction(html);
  });

  it.each([
    { name: "a fast viewer cannot close a still-open event", viewer: AFTER_END },
    { name: "a still-open event stays open with matching clocks", viewer: BEFORE_END },
  ])("$name", async ({ viewer }) => {
    const { kind, html } = await renderAt(BEFORE_END, viewer);
    expect(kind).toBe("ok");
    expect(html).toContain('data-testid="rsvp-going"');
    expect(html).toContain(`action="${PATH}/rsvp"`);
    expect(html).not.toContain('data-testid="rsvp-closed"');
  });

  it.each(["draft", "past"] as const)(
    "%s stays closed before the end on both clocks",
    async (status) => {
      const { kind, html } = await renderAt(BEFORE_END, BEFORE_END, status);
      expect(kind).toBe("ok");
      expect(html).toContain('data-testid="rsvp-closed"');
      expectNoRsvpAction(html);
    },
  );

  it("cancelled stays closed before the end on both clocks", async () => {
    const { kind, html } = await renderAt(BEFORE_END, BEFORE_END, "cancelled");
    expect(kind).toBe("gone");
    expect(html).toContain('data-testid="event-cancelled"');
    expectNoRsvpAction(html);
  });
});
