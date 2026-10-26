// Acceptance-owned synthetic fixtures. Reuse the established calendar fixtures;
// compile the real Kit detail, not a replacement view or browser controller.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { EventPage } from "../../src/events/pages";
import { resolveKitEventDetail, type KitEventDetailStore } from "../../src/events/kit-detail";
import type { Db } from "../../src/db/index";
import type { Env } from "../../src/env";
import type { PublicEvent, ViewerRsvp } from "../../src/events/reads";
import { scanEvent, EVENT_KEY } from "../calendar-card-scan.fixtures";

export { EVENT_KEY, scanEvent };
export const ORIGIN = "https://participation.example.test";
export const DETAIL_PATH = `/e/${EVENT_KEY}`;
export const CUE = "Accessibility details available";
export const HELP = "How RSVPs and waitlists work";
export const NOTES = "Planning-only marker: ask the organizer about the quiet room.";
export const HOSTILE_NOTES = `${NOTES} <img src=x onerror="alert(1)"> & café`;
export type Twin = "Hono" | "Kit";
export interface DetailState {
  name: string;
  member: boolean;
  event?: Partial<PublicEvent>;
  answer?: ViewerRsvp | null;
  position?: number | null;
  present: string[];
  absent: string[];
}
export const detailStates: DetailState[] = [
  { name: "guest", member: false, present: [], absent: ["rsvp-going", "waitlist-join"] },
  { name: "member", member: true, present: ["rsvp-going"], absent: ["waitlist-join"] },
  {
    name: "full",
    member: true,
    event: { goingCount: 8, goingOccupancy: 8 },
    present: ["event-full", "waitlist-join"],
    absent: ["rsvp-going"],
  },
  {
    name: "waitlisted",
    member: true,
    event: { goingCount: 8, goingOccupancy: 8 },
    answer: { status: "waitlisted", syncedToDiscordAt: null },
    position: 2,
    present: ["waitlist-position", "waitlist-leave"],
    absent: ["rsvp-going", "waitlist-join", "waitlist-claim"],
  },
  {
    name: "saved pending mirror",
    member: true,
    answer: { status: "going", syncedToDiscordAt: null },
    present: ["rsvp-confirmed", "rsvp-withdraw", "rsvp-syncing"],
    absent: ["rsvp-going", "rsvp-failed"],
  },
  {
    name: "saved mirrored",
    member: true,
    answer: { status: "going", syncedToDiscordAt: new Date("2029-01-01T12:00:00Z") },
    present: ["rsvp-confirmed", "rsvp-withdraw", "rsvp-synced"],
    absent: ["rsvp-going", "rsvp-syncing"],
  },
  {
    name: "paused new response",
    member: true,
    event: { rsvpOpen: false },
    present: ["rsvp-paused"],
    absent: ["rsvp-going", "waitlist-join", "rsvp-withdraw"],
  },
  {
    name: "paused seat holder",
    member: true,
    event: { rsvpOpen: false },
    answer: { status: "going", syncedToDiscordAt: null },
    present: ["rsvp-paused", "rsvp-withdraw"],
    absent: ["rsvp-going", "waitlist-join"],
  },
  {
    name: "paused waitlisted",
    member: true,
    event: { rsvpOpen: false, goingCount: 8, goingOccupancy: 8 },
    answer: { status: "waitlisted", syncedToDiscordAt: null },
    position: 2,
    present: ["rsvp-paused", "waitlist-leave"],
    absent: ["rsvp-going", "waitlist-join", "waitlist-claim"],
  },
];

export function detailEvent(state: DetailState, notes: string | null = NOTES) {
  return scanEvent({ accessibilityNotes: notes, ...state.event });
}

let bundle: Promise<(model: Record<string, unknown>) => string> | undefined;
function kitRenderer() {
  bundle ??= (async () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    const webRequire = createRequire(join(root, "web/package.json"));
    const { compile } = webRequire("svelte/compiler") as {
      compile(source: string, options: Record<string, unknown>): { js: { code: string } };
    };
    const scratch = mkdtempSync(
      join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "participation-ssr-"),
    );
    try {
      const outfile = join(scratch, "detail.mjs");
      await build({
        stdin: {
          contents: `import {render} from "svelte/server";
import Detail from ${JSON.stringify(join(root, "web/src/lib/EventDetail.svelte"))};
export const renderDetail = model => { const {head,body}=render(Detail,{props:{model}}); return "<!doctype html><html lang=\\"en\\"><head><meta charset=\\"utf-8\\">"+head+"</head><body>"+body+"</body></html>"; };`,
          loader: "ts",
          resolveDir: root,
        },
        bundle: true,
        platform: "node",
        format: "esm",
        outfile,
        logLevel: "silent",
        nodePaths: [join(root, "web/node_modules"), join(root, "node_modules")],
        alias: { "#lib": join(root, "web/src/lib") },
        plugins: [
          {
            name: "participation-real-svelte",
            setup(plugin) {
              plugin.onLoad({ filter: /\.svelte$/ }, ({ path }) => ({
                contents: compile(readFileSync(path, "utf8"), {
                  generate: "server",
                  dev: false,
                  filename: path,
                }).js.code,
                loader: "js",
                resolveDir: dirname(path),
              }));
            },
          },
        ],
      });
      return (await import(pathToFileURL(outfile).href)).renderDetail as (
        model: Record<string, unknown>,
      ) => string;
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  })();
  return bundle;
}

export async function renderDetail(twin: Twin, state: DetailState, notes: string | null = NOTES) {
  const event = detailEvent(state, notes);
  const session = state.member
    ? {
        userId: "100000000000000001",
        username: "fixture-member",
        avatar: null,
        member: true,
        moderator: false,
      }
    : null;
  const calls: string[] = [];
  if (twin === "Hono") {
    return {
      html: String(
        EventPage({
          e: event,
          member: state.member,
          session: session ? { ...session, id: session.userId } : null,
          answer: state.answer ?? null,
          waitlistPosition: state.position ?? null,
          returnTo: DETAIL_PATH,
          neighbors: { previous: null, next: null },
          related: [],
          attendees: [],
          appUrl: ORIGIN,
          jsonLd: "{}",
        }),
      ),
      calls,
      headers: {} as Record<string, string>,
    };
  }
  const read =
    <T>(name: string, value: T) =>
    async () => {
      calls.push(name);
      return value;
    };
  const store: KitEventDetailStore = {
    dbForFn: read("db", {} as Db),
    getEventFn: read("event", event),
    neighborsFn: read("neighbors", { previous: null, next: null }),
    relatedFn: read("related", []),
    seriesFn: read("series", null),
    attendeesFn: read("attendees", []),
    viewerRsvpFn: read("answer", state.answer ?? null),
    waitlistFn: read("waitlist", state.position ?? null),
    suggestionsFn: read("suggestions", []),
  };
  const headers: Record<string, string> = {};
  const outcome = await resolveKitEventDetail({
    key: EVENT_KEY,
    search: "",
    path: DETAIL_PATH,
    env: { APP_URL: ORIGIN } as Env,
    session: session ? { status: "authenticated", session } : { status: "guest", session: null },
    joinResult: null,
    setHeaders: (next) => Object.assign(headers, next),
    store,
  });
  if (outcome.kind !== "ok") throw new Error(`Fixture expected detail, received ${outcome.kind}`);
  return {
    html: (await kitRenderer())(outcome.model as unknown as Record<string, unknown>),
    calls,
    headers,
  };
}
