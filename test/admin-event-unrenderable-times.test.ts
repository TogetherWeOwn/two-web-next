// Moderator inventory resilience: one imported event row whose stored
// timestamps cannot be represented as a JS Date (Postgres infinity or an
// out-of-range year decodes to an Invalid Date) must not take down the
// events list or the edit page — the bad row is exactly the row a moderator
// needs to open and repair. These pins drive the admin read seams directly:
// the Hono EventsPage render, the Kit list serializer, the Kit edit read
// model, and the PATCH merge that saves a corrected time.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { jsx } from "hono/jsx/jsx-runtime";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseEventListQuery } from "../src/admin/event-list";
import {
  resolveKitEventEdit,
  type KitEventEditDeps,
  type KitEventEditRow,
} from "../src/admin/kit-event-edit";
import {
  buildEventListView,
  serializeEventListRow,
  type KitEventListView,
} from "../src/admin/kit-events";
import { EventsPage } from "../src/admin/pages";
import { mergePatchInput, type EventListRow, type PatchBase } from "../src/admin/store";
import { ValidationError } from "../src/admin/validation-shared";
import type { Db } from "../src/db/index";

const INVALID = new Date(Number.NaN);

function listRow(over: Partial<EventListRow> & { eventKey: string }): EventListRow {
  const at = new Date("2026-11-01T18:00:00.000Z");
  const { eventKey, ...rest } = over;
  return {
    id: 1,
    eventKey,
    title: eventKey,
    game: null,
    description: null,
    startsAt: at,
    endsAt: new Date("2026-11-01T21:00:00.000Z"),
    timezone: "Europe/London",
    location: null,
    capacity: 8,
    status: "published",
    discordEventId: null,
    discordSyncFailedAt: null,
    discordSyncFailureCode: null,
    agentGrantId: null,
    proofMarker: null,
    agentVersion: 1,
    createdBy: null,
    rsvpOpen: true,
    recurrenceFrequency: null,
    recurrenceCount: null,
    recurrenceEndsOn: null,
    parentEventId: null,
    recurrenceIndex: null,
    createdAt: at,
    updatedAt: at,
    icsSequence: 0n,
    syncRevision: 0,
    syncedRevision: 0,
    goingCount: 3,
    ...rest,
  } as EventListRow;
}

describe("Hono moderator inventory with an unrenderable stored time", () => {
  const normal = listRow({ eventKey: "EVTNORMAL1", title: "Friday game night" });
  const badStart = listRow({
    eventKey: "EVTBADSTART",
    title: "Imported night (broken start)",
    startsAt: INVALID,
    status: "draft",
  });
  const badEnd = listRow({
    eventKey: "EVTBADEND1",
    title: "Imported night (broken end)",
    endsAt: INVALID,
  });

  it("renders every row: finite rows byte-identical, bad rows visibly flagged", () => {
    const html = String(
      jsx(EventsPage, {
        rows: [normal, badStart, badEnd],
        query: parseEventListQuery({}),
        hasNext: false,
      }),
    );
    // The finite row keeps its exact time bytes.
    expect(html).toContain(
      '<time datetime="2026-11-01T18:00:00.000Z">2026-11-01T18:00:00.000Z</time>',
    );
    // The bad-start row stays visible and identifiable, with a placeholder
    // instead of a <time> element the instant cannot fill.
    expect(html).toContain("/admin/events/EVTBADSTART");
    expect(html).toContain("Imported night (broken start)");
    expect(html).toContain('data-testid="event-status-EVTBADSTART"');
    expect(html).toContain('data-testid="event-unrenderable-time-EVTBADSTART"');
    expect(html).toContain("Unrenderable time");
    // The bad-end row keeps its renderable start and flags the broken end.
    expect(html).toContain('data-testid="event-unrenderable-time-EVTBADEND1"');
    // No invalid instant ever reaches a datetime attribute.
    expect(html).not.toContain('datetime=""');
    expect(html).not.toContain("Invalid Date");
  });

  it("offers no RSVP pause/reopen for a published row whose end is unrenderable", () => {
    const html = String(
      jsx(EventsPage, {
        rows: [badEnd],
        query: parseEventListQuery({}),
        hasNext: false,
      }),
    );
    expect(html).not.toContain("rsvp-pause");
    expect(html).not.toContain("rsvp-reopen");
    expect(html).not.toContain("Pause RSVPs");
  });
});

describe("Kit moderator inventory with an unrenderable stored time", () => {
  it("serializes nonfinite instants as empty strings and keeps the row", () => {
    const bad = listRow({
      eventKey: "EVTBADSTART",
      title: "Imported night (broken start)",
      startsAt: INVALID,
      endsAt: INVALID,
      status: "draft",
    });
    expect(serializeEventListRow(bad)).toEqual({
      eventKey: "EVTBADSTART",
      title: "Imported night (broken start)",
      game: null,
      status: "draft",
      startsAt: "",
      endsAt: "",
      capacity: 8,
      rsvpOpen: true,
      goingCount: 3,
    });
  });

  it("keeps the bad row in the view alongside finite rows", () => {
    const view = buildEventListView(parseEventListQuery({}), [
      listRow({ eventKey: "EVTNORMAL1" }),
      listRow({ eventKey: "EVTBADEND1", endsAt: INVALID }),
    ]);
    expect(view.rows.map((r) => r.eventKey)).toEqual(["EVTNORMAL1", "EVTBADEND1"]);
    expect(view.rows[0]!.startsAt).toBe("2026-11-01T18:00:00.000Z");
    expect(view.rows[0]!.endsAt).toBe("2026-11-01T21:00:00.000Z");
    expect(view.rows[1]!.startsAt).toBe("2026-11-01T18:00:00.000Z");
    expect(view.rows[1]!.endsAt).toBe("");
  });

  // Executed, not structural: the real Kit events page, SSR-compiled with
  // the web workspace's svelte/compiler and bundled by esbuild (same shape
  // as test/kit-admin-event-edit-acceptance.test.ts), rendered with the
  // serialized mixed rows the load hands it. A source-substring pin cannot
  // see a deleted display branch; these assertions fail when either
  // placeholder branch is removed or disabled.
  describe("Kit page SSR with mixed renderable and unrenderable rows", () => {
    const root = fileURLToPath(new URL("../", import.meta.url).href);
    let scratch = "";
    let renderList: (data: KitEventListView) => string;

    beforeAll(async () => {
      scratch = mkdtempSync(
        join(process.env.PAPERCLIP_SCRATCH_DIR ?? tmpdir(), "kit-events-unrenderable-"),
      );
      const webRequire = createRequire(join(root, "web/package.json"));
      const { compile } = webRequire("svelte/compiler") as {
        compile(source: string, options: Record<string, unknown>): { js: { code: string } };
      };
      const entry = join(scratch, "entry.mjs");
      writeFileSync(
        entry,
        `import { render } from "svelte/server";
import Page from ${JSON.stringify(join(root, "web/src/routes/admin/events/+page.svelte"))};
export function renderList(data) { return render(Page, { props: { data } }).body; }`,
      );
      const outfile = join(scratch, "bundle.mjs");
      await build({
        entryPoints: [entry],
        outfile,
        bundle: true,
        platform: "node",
        format: "esm",
        logLevel: "warning",
        tsconfigRaw: { compilerOptions: {} },
        absWorkingDir: root,
        nodePaths: [join(root, "web/node_modules"), join(root, "node_modules")],
        alias: { "#lib": join(root, "web/src/lib") },
        plugins: [
          {
            name: "kit-events-unrenderable-ssr",
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
      renderList = (await import(pathToFileURL(outfile).href)).renderList;
    }, 120000);

    afterAll(() => {
      if (scratch) rmSync(scratch, { recursive: true, force: true });
    });

    function mixedView(): KitEventListView {
      return buildEventListView(parseEventListQuery({}), [
        listRow({ eventKey: "EVTNORMAL1", title: "Friday game night" }),
        listRow({
          eventKey: "EVTBADSTART",
          title: "Imported night (broken start)",
          startsAt: INVALID,
          endsAt: INVALID,
          status: "draft",
        }),
        listRow({
          eventKey: "EVTBADEND1",
          title: "Imported night (broken end)",
          startsAt: new Date("2026-11-02T18:00:00.000Z"),
          endsAt: INVALID,
        }),
      ]);
    }

    it("renders the finite row with its exact time bytes and no placeholder", () => {
      const html = renderList(mixedView());
      expect(html).toContain(
        '<time datetime="2026-11-01T18:00:00.000Z">2026-11-01T18:00:00.000Z</time>',
      );
      expect(html).not.toContain("event-unrenderable-time-EVTNORMAL1");
    });

    it("flags the broken-start row with the exact start marker, row intact", () => {
      const html = renderList(mixedView());
      expect(html).toContain("/admin/events/EVTBADSTART");
      expect(html).toContain("Imported night (broken start)");
      expect(html).toContain('data-testid="event-unrenderable-time-EVTBADSTART"');
      expect(html).toContain(">Unrenderable time</span>");
    });

    it("keeps the renderable start and flags the broken end with the exact end marker", () => {
      const html = renderList(mixedView());
      expect(html).toContain(
        '<time datetime="2026-11-02T18:00:00.000Z">2026-11-02T18:00:00.000Z</time>',
      );
      expect(html).toContain('data-testid="event-unrenderable-time-EVTBADEND1"');
      expect(html).toContain("(unrenderable end time)");
    });

    it("emits no empty datetime attribute and no Invalid Date text", () => {
      const html = renderList(mixedView());
      expect(html).not.toContain('datetime=""');
      expect(html).not.toContain("Invalid Date");
    });
  });
});

describe("Kit event edit with unrenderable stored times", () => {
  const db = {} as Db;
  const baseRow: KitEventEditRow = {
    eventKey: "EVTBADSTART",
    title: "Imported night (broken start)",
    game: "Chess",
    description: "Casual play",
    startsAt: INVALID,
    endsAt: INVALID,
    timezone: "Europe/London",
    location: "Hall",
    capacity: 8,
    status: "published",
    rsvpOpen: true,
    recurrenceFrequency: null,
  };

  function depsFor(row: KitEventEditRow): KitEventEditDeps {
    return {
      db,
      get: async () => ({ ...row }),
      list: async () => ({ rows: [], total: 0 }),
      now: new Date("2026-10-01T12:00:00.000Z"),
    };
  }

  it("opens with empty time fields the moderator can correct, like the Hono twin", async () => {
    const outcome = await resolveKitEventEdit("EVTBADSTART", {}, depsFor(baseRow));
    if (outcome.kind !== "ok") throw new Error("expected ok");
    expect(outcome.view.title).toBe("Imported night (broken start)");
    expect(outcome.view.values.title).toBe("Imported night (broken start)");
    expect(outcome.view.values.starts_at).toBe("");
    expect(outcome.view.values.ends_at).toBe("");
    expect(outcome.view.values.timezone).toBe("Europe/London");
    expect(outcome.view.endsAt).toBe("");
    // A published row with no renderable end is never offered the RSVP toggle.
    expect(outcome.view.rsvpAction).toBeNull();
  });

  it("leaves wall fields empty for an unknown stored timezone, keeping the zone visible", async () => {
    const outcome = await resolveKitEventEdit(
      "EVTBADSTART",
      {},
      depsFor({
        ...baseRow,
        startsAt: new Date("2026-11-01T18:00:00.000Z"),
        endsAt: new Date("2026-11-01T21:00:00.000Z"),
        timezone: "Mars/Olympus",
      }),
    );
    if (outcome.kind !== "ok") throw new Error("expected ok");
    expect(outcome.view.values.starts_at).toBe("");
    expect(outcome.view.values.ends_at).toBe("");
    expect(outcome.view.values.timezone).toBe("Mars/Olympus");
    // The stored instant itself is renderable, so its ISO carrier survives.
    expect(outcome.view.endsAt).toBe("2026-11-01T21:00:00.000Z");
  });
});

describe("saving a corrected time over an unrenderable stored row", () => {
  const base: PatchBase = {
    title: "Imported night (broken start)",
    game: null,
    description: null,
    accessibilityNotes: null,
    timezone: "Europe/London",
    location: "Hall",
    organizer_name: null,
    join_url: null,
    join_instructions: null,
    capacity: null,
    startsAt: INVALID,
    endsAt: INVALID,
  };

  it("parses the replacement wall times instead of formatting the stored instants", () => {
    const input = mergePatchInput(base, {
      starts_at: "2026-11-01 19:00",
      ends_at: "2026-11-01 22:00",
    });
    // November London is GMT, so wall text is the UTC instant.
    expect(input.startsAtUtc.toISOString()).toBe("2026-11-01T19:00:00.000Z");
    expect(input.endsAtUtc.toISOString()).toBe("2026-11-01T22:00:00.000Z");
  });

  it("refuses an omitted time with a field error, never a RangeError", () => {
    try {
      mergePatchInput(base, { title: "Still broken" });
      throw new Error("expected refusal");
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).fields.starts_at).toBe("Enter a valid start time.");
      expect((err as ValidationError).fields.ends_at).toBe("Enter a valid end time.");
    }
  });
});
