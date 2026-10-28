// Independent acceptance fixtures. Only current GET presentations are compiled;
// every native rejected POST belongs to Hono, including posts from Kit forms.
import { build } from "esbuild";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { EventFormFields } from "../../src/admin/pages/event-form-fields";
import { EventFormPage, FeaturedFormPage } from "../../src/admin/pages";
import type { EventRow, FeaturedRow } from "../../src/admin/store";
import { buildEventCreateView } from "../../src/admin/kit-event-create";
import { resolveKitEventEdit } from "../../src/admin/kit-event-edit";
import { resolveKitFeaturedEdit } from "../../src/admin/kit-featured-edit";
import { parseEventForm, parseFeaturedForm, ValidationError } from "../../src/admin/validation";
import { parseRecurrenceForm } from "../../src/admin/recurrence";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const key = "01J0000000000000000000ABCD";
export const now = new Date("2026-10-20T12:00:00Z");
export const eventValues = {
  title: 'Draft <night> & "friends"',
  game: "Chess",
  description: "Keep my\nsecond line <literal>",
  starts_at: "2026-03-29 01:30",
  ends_at: "2026-03-29 03:30",
  timezone: "Europe/London",
  location: "Voice & games",
  capacity: "0",
  recurrence_frequency: "weekly",
  recurrence_count: "53",
  recurrence_ends_on: "",
};
export const featuredValues = {
  title: 'Draft <headline> & "friends"',
  body: "Keep my\nfeatured <copy>",
  url: "https://example.com/read?x=1&y=2",
  image_url: "https://unapproved.example.com/photo.png",
  image_alt: "",
  is_published: "on",
  position: "-1",
  starts_at: "2026-10-21 12:00",
  ends_at: "2026-10-20 12:00",
};
export const eventRow: EventRow = {
  id: 1,
  eventKey: key,
  title: "Saved game night",
  game: "Saved game",
  description: "Saved copy",
  location: "Saved room",
  timezone: "Europe/London",
  capacity: 8,
  startsAt: new Date("2026-11-04T20:00:00Z"),
  endsAt: new Date("2026-11-04T22:00:00Z"),
  discordEventId: null,
  discordSyncFailedAt: null,
  discordSyncFailureCode: null,
  agentGrantId: null,
  proofMarker: null,
  agentVersion: 1,
  recurrenceFrequency: null,
  recurrenceCount: null,
  recurrenceEndsOn: null,
  parentEventId: null,
  recurrenceIndex: null,
  icsSequence: 0n,
  syncRevision: 1,
  syncedRevision: 0,
  status: "draft",
  rsvpOpen: true,
  createdBy: null,
  createdAt: now,
  updatedAt: now,
};
export const featuredRow: FeaturedRow = {
  id: 7,
  legacyId: null,
  title: "Saved headline",
  body: "Saved featured copy",
  url: null,
  imageUrl: null,
  imageAlt: null,
  isPublished: false,
  position: 0,
  startsAt: null,
  endsAt: null,
  createdBy: null,
  createdAt: now,
  updatedAt: now,
};

// These are literal independent expectations, not computed from a validator.
export const eventTargets = {
  title: "f-title",
  game: "f-game",
  description: "f-description",
  starts_at: "f-starts-at",
  ends_at: "f-ends-at",
  timezone: "f-timezone",
  location: "f-location",
  capacity: "f-capacity",
};
export const recurrenceTargets = {
  recurrence_frequency: "f-recurrence-frequency",
  recurrence_count: "f-recurrence-count",
  recurrence_ends_on: "f-recurrence-ends-on",
};
export const featuredTargets = {
  title: "f-title",
  body: "f-body",
  url: "f-url",
  image_url: "f-image-url",
  image_alt: "f-image-alt",
  position: "f-position",
  starts_at: "f-starts-at",
  ends_at: "f-ends-at",
};
export const globalError = 'Cannot save <img src=x onerror="window.summaryInjected=1"> & retry.';
export const eventErrors = {
  title: "Give the event a title.",
  game: "Keep the game to 100 characters.",
  description: "Keep the description to 1000 characters.",
  starts_at: "That wall time does not exist in Europe/London.",
  ends_at: "The end is after the start.",
  timezone: "Unknown timezone: Invalid/Zone.",
  location: "Keep the location to 255 characters.",
  capacity: "Capacity is a headcount from 1 to 2147483647, or empty for unlimited.",
};
export const recurrenceErrors = {
  recurrence_frequency: "Only weekly repeats are supported.",
  recurrence_count: "Choose at most 52 occurrences.",
  recurrence_ends_on: "Give a valid repeat-until date.",
};
export const featuredErrors = {
  title: "Give it a headline.",
  body: "Keep the body to 1000 characters.",
  url: "Link is a full http(s) URL, or empty for no link.",
  image_url: "Image URL must be HTTPS on an approved public host.",
  image_alt: "Describe the photo in one plain sentence for screen-reader visitors.",
  position: "Position is a whole number from 0 to 2147483647; lower numbers appear first.",
  starts_at: "Not a date and time.",
  ends_at: "The window ends after it starts.",
};

export type FormFixture = {
  name: string;
  kind: "event" | "featured";
  mode: "new" | "edit";
  kit: boolean;
  path: string;
  action: string;
  html: string;
  errors: Record<string, string>;
  targets: Record<string, string>;
};

export async function compileKitForms() {
  const scratch = mkdtempSync(
    join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "validation-correction-"),
  );
  const webRequire = createRequire(join(root, "web/package.json"));
  const { compile } = webRequire("svelte/compiler");
  const paths = ["events/new", "events/[key]", "featured/new", "featured/[id]"];
  const outfile = join(scratch, "forms.mjs");
  try {
    await build({
      stdin: {
        contents: `import { render } from 'svelte/server';\n${paths.map((p, i) => `import P${i} from ${JSON.stringify(join(root, `web/src/routes/admin/${p}/+page.svelte`))};`).join("\n")}\nconst pages=[P0,P1,P2,P3]; export const renderForm=(i,data)=>render(pages[i],{props:{data}}).body;`,
        resolveDir: root,
        sourcefile: "acceptance-forms.mjs",
      },
      bundle: true,
      platform: "node",
      format: "esm",
      outfile,
      logLevel: "silent",
      absWorkingDir: root,
      nodePaths: [join(root, "web/node_modules"), join(root, "node_modules")],
      alias: { "#lib": join(root, "web/src/lib") },
      plugins: [
        {
          name: "acceptance-kit-ssr",
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
    const { renderForm } = await import(pathToFileURL(outfile).href);
    return {
      renderForm: renderForm as (i: number, data: unknown) => string,
      dispose: () => rmSync(scratch, { recursive: true, force: true }),
    };
  } catch (error) {
    rmSync(scratch, { recursive: true, force: true });
    throw error;
  }
}

export async function formFixtures(
  kit: Awaited<ReturnType<typeof compileKitForms>>,
  rejected: boolean,
): Promise<FormFixture[]> {
  const result: FormFixture[] = [];
  for (const mode of ["new", "edit"] as const) {
    const eventPath = mode === "new" ? "/admin/events/new" : `/admin/events/${key}`;
    const eventAction = mode === "new" ? "/admin/events" : eventPath;
    const featuredPath = mode === "new" ? "/admin/featured/new" : "/admin/featured/7";
    const featuredAction = mode === "new" ? "/admin/featured" : featuredPath;
    const errors = rejected
      ? { ...eventErrors, ...(mode === "new" ? recurrenceErrors : {}), global: globalError }
      : {};
    const targets = { ...eventTargets, ...(mode === "new" ? recurrenceTargets : {}) };
    result.push({
      name: `Hono event ${mode}`,
      kind: "event",
      mode,
      kit: false,
      path: eventPath,
      action: eventAction,
      html: await EventFormPage({ mode, row: eventRow, values: eventValues, errors })!.toString(),
      errors,
      targets,
    });
    const view = await resolveKitEventEdit(
      key,
      {},
      {
        db: {} as never,
        get: async () => eventRow,
        list: async () => ({ rows: [], total: 0 }),
        now,
      },
    );
    if (view.kind !== "ok") throw new Error("invalid local event fixture");
    const data =
      mode === "new"
        ? buildEventCreateView(eventValues, errors)
        : {
            view: {
              ...view.view,
              values: eventValues,
              formHtml: EventFormFields({
                mode,
                row: eventRow,
                values: eventValues,
                errors,
                action: eventAction,
              }).toString(),
              errors,
              hasErrors: rejected,
              isDraft: rejected,
            },
          };
    result.push({
      name: `Kit event ${mode}`,
      kind: "event",
      mode,
      kit: true,
      path: eventPath,
      action: eventAction,
      html: kit.renderForm(mode === "new" ? 0 : 1, data),
      errors,
      targets,
    });
    const fErrors = rejected ? { ...featuredErrors, global: globalError } : {};
    result.push({
      name: `Hono featured ${mode}`,
      kind: "featured",
      mode,
      kit: false,
      path: featuredPath,
      action: featuredAction,
      html: await FeaturedFormPage({
        mode,
        row: featuredRow,
        values: featuredValues,
        errors: fErrors,
        now,
        appUrl: "https://example.test",
      })!.toString(),
      errors: fErrors,
      targets: featuredTargets,
    });
    // Featured Kit pages accept no rejection map. A native POST goes to the
    // Hono renderer; do not fabricate a Kit action or Kit-only error renderer.
    if (!rejected) {
      const featured = await resolveKitFeaturedEdit("7", {
        db: {} as never,
        get: async () => ({ ...featuredRow, startsAtText: null, endsAtText: null }),
        now,
      });
      if (featured.kind !== "ok") throw new Error("invalid local featured fixture");
      result.push({
        name: `Kit featured ${mode}`,
        kind: "featured",
        mode,
        kit: true,
        path: featuredPath,
        action: featuredAction,
        html: kit.renderForm(mode === "new" ? 2 : 3, mode === "new" ? {} : { view: featured.view }),
        errors: {},
        targets: featuredTargets,
      });
    }
  }
  return result;
}

export function validationErrors(
  kind: "event" | "featured",
  mode: "new" | "edit",
  values: Record<string, string>,
): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const parse of kind === "featured"
    ? [parseFeaturedForm]
    : mode === "new"
      ? [parseEventForm, parseRecurrenceForm]
      : [parseEventForm]) {
    try {
      parse(values);
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      Object.assign(errors, error.fields);
    }
  }
  return errors;
}

export async function rejectedHtml(
  kind: "event" | "featured",
  mode: "new" | "edit",
  values: Record<string, string>,
): Promise<string> {
  const errors = validationErrors(kind, mode, values);
  if (!Object.keys(errors).length) throw new Error("fixture POST must really fail validation");
  return kind === "event"
    ? await EventFormPage({ mode, row: eventRow, values, errors })!.toString()
    : await FeaturedFormPage({
        mode,
        row: featuredRow,
        values,
        errors,
        now,
        appUrl: "https://example.test",
      })!.toString();
}

export function summaryFragment(html: string): string {
  // Existing stable hook; allow a paragraph, section, div or any list layout.
  const match = /<([a-z][\w-]*)\b[^>]*\bdata-testid="form-errors"[^>]*>[\s\S]*?<\/\1>/.exec(html);
  return match?.[0] ?? "";
}
