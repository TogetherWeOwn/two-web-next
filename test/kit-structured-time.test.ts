// Structured-time `row` presentation: the pure model plus StructuredTime.svelte
// compiled for SSR. Timestamps are test data. Mount/hydration needs a browser
// and is not exercised here; the component has no effect, so hydration has
// nothing to change after the server bytes.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { build } from "esbuild";
import { beforeAll, describe, expect, it } from "vitest";
import { rowTimeModel, type RowTimeInput } from "../web/src/lib/structured-time";

const { compile } = createRequire(new URL("../web/package.json", import.meta.url))(
  "svelte/compiler",
) as { compile: (src: string, o: object) => { js: { code: string } } };
const root = fileURLToPath(new URL("../", import.meta.url));
const component = join(root, "web/src/lib/StructuredTime.svelte");
let render: (props: RowTimeInput) => string;

beforeAll(async () => {
  const scratch = mkdtempSync(join(tmpdir(), "kit-structured-time-"));
  const entry = join(scratch, "entry.mjs");
  writeFileSync(
    entry,
    `import { render as r } from "svelte/server";
import C from ${JSON.stringify(component)};
export const render = (props) => r(C, { props }).body;`,
  );
  const outfile = join(scratch, "out.mjs");
  await build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile,
    logLevel: "warning",
    absWorkingDir: root,
    nodePaths: [join(root, "web/node_modules"), join(root, "node_modules")],
    alias: { "#lib": join(root, "web/src/lib") },
    plugins: [
      {
        name: "svelte-ssr",
        setup: (plugin) =>
          plugin.onLoad({ filter: /\.svelte$/ }, (args) => ({
            contents: compile(readFileSync(args.path, "utf8"), {
              generate: "server",
              dev: false,
              filename: args.path,
            }).js.code,
            loader: "js",
            resolveDir: dirname(args.path),
          })),
      },
    ],
  });
  ({ render } = await import(pathToFileURL(outfile).href));
  rmSync(scratch, { recursive: true, force: true });
}, 120000);

// Saturday 7 November 2026, 19:30 UTC (GMT in London).
const START = "2026-11-07T19:30:00.000Z";
const base: RowTimeInput = { state: "upcoming", startsAt: START, zone: "Europe/London" };
const lines = (i: RowTimeInput) => {
  const m = rowTimeModel(i);
  return [m.line1, m.line2];
};

describe("row time model", () => {
  it("upcoming: weekday and time, then the named zone", () => {
    expect(lines(base)).toEqual(["Sat 19:30", "Europe/London"]);
    expect(rowTimeModel(base)).toMatchObject({ iso: START, struck: false, cancelled: false });
  });

  it("past: date, then ended when the end is known, else the zone", () => {
    const past: RowTimeInput = { ...base, state: "past" };
    expect(lines(past)).toEqual(["Sat 7 Nov", "Europe/London"]);
    expect(lines({ ...past, endsAt: "2026-11-07T21:00:00Z" })).toEqual(["Sat 7 Nov", "ended"]);
    expect(lines({ ...past, endsAt: "garbage" })).toEqual(["Sat 7 Nov", "Europe/London"]);
    expect(lines({ ...past, endsAt: null })[1]).toBe("Europe/London");
  });

  it("cancelled: struck date plus the word, then the zone", () => {
    const m = rowTimeModel({ ...base, state: "cancelled" });
    expect([m.line1, m.line2, m.struck, m.cancelled]).toEqual([
      "Sat 7 Nov",
      "Europe/London",
      true,
      true,
    ]);
  });

  it("renders in the stored zone, so the weekday and day follow it", () => {
    expect(lines({ ...base, zone: "Asia/Tokyo" })).toEqual(["Sun 04:30", "Asia/Tokyo"]);
    expect(lines({ ...base, state: "past", zone: "Asia/Tokyo" })[0]).toBe("Sun 8 Nov");
  });

  it("reads and names an invalid or absent zone as UTC, never the viewer", () => {
    for (const zone of ["Not/AZone", "", null, undefined]) {
      expect(lines({ ...base, zone })).toEqual(["Sat 19:30", "UTC"]);
    }
  });

  it("is unavailable, with no instant, for absent or unsafe values", () => {
    const bad = [
      null,
      undefined,
      "",
      "nope",
      new Date(Number.NaN),
      "2026-11-07T19:30:00",
      "2026-11-07",
      "2026-02-30T19:30:00Z",
    ];
    for (const state of ["upcoming", "past", "cancelled"] as const) {
      for (const startsAt of bad) {
        expect(rowTimeModel({ ...base, state, startsAt })).toEqual({
          available: false,
          iso: "",
          line1: "Time to be confirmed",
          line2: "",
          struck: false,
          cancelled: false,
        });
      }
    }
  });

  it("accepts Date values and explicit offsets as the same instant", () => {
    const offset = rowTimeModel({ ...base, startsAt: "2026-11-07T20:30:00+01:00" });
    expect(offset.iso).toBe(START);
    expect(rowTimeModel({ ...base, startsAt: new Date(START) }).iso).toBe(START);
  });
});

describe("StructuredTime.svelte SSR", () => {
  it("renders the upcoming row with a semantic UTC time and the zone", () => {
    const html = render(base);
    expect(html).toContain(`<time datetime="${START}">Sat 19:30</time>`);
    expect(html).toContain("Europe/London");
    expect(html).not.toMatch(/Cancelled|<s>|<script|Time to be confirmed/);
  });

  it("renders past with ended, and cancelled struck with the visible word", () => {
    expect(render({ ...base, state: "past", endsAt: START })).toContain(">ended<");
    const html = render({ ...base, state: "cancelled" });
    expect(html).toContain(`<s><time datetime="${START}">Sat 7 Nov</time></s>`);
    expect(html).toContain("Cancelled");
  });

  it("renders the unavailable row without a time element", () => {
    const html = render({ ...base, startsAt: "nope", zone: "Europe/London" });
    expect(html).toContain("Time to be confirmed");
    expect(html).not.toMatch(/<time|Europe\/London|line2/);
  });

  it("is deterministic and relative-text free", () => {
    expect(render(base)).toBe(render({ ...base }));
    expect(render(base)).not.toMatch(/\bin \d|\bago\b|as of|your time/);
  });

  it("has no client-only behaviour and uses only generated tokens", () => {
    const src = readFileSync(component, "utf8");
    expect(src).not.toMatch(/\$effect|onMount|setTimeout|setInterval|resolvedOptions/);
    expect(src).toContain("var(--t3)");
    expect(src).not.toMatch(/#[0-9a-f]{3,6}\b/i);
    expect(src).toContain("flex-direction: column");
  });
});
