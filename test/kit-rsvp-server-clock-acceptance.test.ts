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
import { visibleText } from "./helpers/event-ongoing-acceptance";
import {
  attribute,
  document,
  elements,
  tag,
  testId,
} from "./helpers/schedule-search-context-acceptance";

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
  review = false,
) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(serverNow));
  const session =
    review || status === "draft"
      ? { ...member, session: { ...member.session!, moderator: true } }
      : member;
  const outcome = await resolveKitEventDetail({
    key: KEY,
    search: review ? "?review=1" : "",
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
      page: document(renderDetail(outcome.model as unknown as Record<string, unknown>)),
    };
  }
  if (outcome.kind === "gone") {
    return {
      kind: outcome.kind,
      page: document(renderGone(outcome.model as unknown as Record<string, unknown>)),
    };
  }
  throw new Error(`expected event presentation, got ${outcome.kind}`);
}

function expectNoRsvpAction(page: ReturnType<typeof document>) {
  expect(testId(page, "rsvp-going")).toHaveLength(0);
  expect(testId(page, "waitlist-join")).toHaveLength(0);
  expect(testId(page, "rsvp-withdraw")).toHaveLength(0);
  expect(
    elements(
      page,
      (element) =>
        attribute(element, "action") === `${PATH}/rsvp` ||
        attribute(element, "formaction") === `${PATH}/rsvp`,
    ),
  ).toHaveLength(0);
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
    const { kind, page } = await renderAt(server, viewer);
    expect(kind).toBe("ok");
    const [record] = testId(page, "event-past");
    expect(record).toBeDefined();
    expect(tag(record!, "h2").map(visibleText)).toContain("Sign-up record");
    expectNoRsvpAction(page);
  });

  it.each(["published", "past"] as const)(
    "keeps the ended %s record and inert RSVP in moderator preview",
    async (status) => {
      const { kind, page } = await renderAt(AFTER_END, BEFORE_END, status, true);
      expect(kind).toBe("ok");
      const heading = tag(page, "h2").find(
        (node) => attribute(node, "id") === "signup-record-heading",
      );
      expect(heading).toBeDefined();
      const button = tag(page, "button").find(
        (node) =>
          attribute(node, "aria-describedby") === "preview-rsvp-hint" &&
          attribute(node, "disabled") !== undefined,
      );
      expect(button).toBeDefined();
      const [hint] = elements(page, (node) => attribute(node, "id") === "preview-rsvp-hint");
      expect(hint).toBeDefined();
      expect(visibleText(hint!)).toBe("RSVP is disabled in preview.");
      expectNoRsvpAction(page);
    },
  );

  it.each([
    { name: "a fast viewer cannot close a still-open event", viewer: AFTER_END },
    { name: "a still-open event stays open with matching clocks", viewer: BEFORE_END },
  ])("$name", async ({ viewer }) => {
    const { kind, page } = await renderAt(BEFORE_END, viewer);
    expect(kind).toBe("ok");
    const form = tag(page, "form").find((node) => attribute(node, "action") === `${PATH}/rsvp`);
    expect(form).toBeDefined();
    expect(testId(form!, "rsvp-going").some((node) => node.tagName === "button")).toBe(true);
    expect(testId(page, "rsvp-closed")).toHaveLength(0);
  });

  it.each(["draft", "past"] as const)(
    "%s stays closed before the end on both clocks",
    async (status) => {
      const { kind, page } = await renderAt(BEFORE_END, BEFORE_END, status);
      expect(kind).toBe("ok");
      expect(testId(page, "rsvp-closed").length).toBeGreaterThan(0);
      expectNoRsvpAction(page);
    },
  );

  it("cancelled stays closed before the end on both clocks", async () => {
    const { kind, page } = await renderAt(BEFORE_END, BEFORE_END, "cancelled");
    expect(kind).toBe("gone");
    expect(testId(page, "event-cancelled").length).toBeGreaterThan(0);
    expectNoRsvpAction(page);
  });
});
