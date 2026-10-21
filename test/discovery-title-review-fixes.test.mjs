// Review corrections for state-derived discovery titles (PR review, not the
// paired acceptance vectors): titleQuery must agree with matchQuery on NUL/CR
// input, and hot-zone signal pages must name their season on both twins.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { beforeAll, describe, expect, it } from "vitest";
import { matchQuery } from "../src/events/search-log";
import { HotzoneSignalPage, renderHotzoneGrid } from "../src/hotzones/pages";
import { eventsTitle, hotzoneSignalTitle, pastEventsTitle } from "../src/seo";

const root = fileURLToPath(new URL("../", import.meta.url));
const webRequire = createRequire(join(root, "web/package.json"));
const { compile } = webRequire("svelte/compiler");
let renderSignalKit;

beforeAll(async () => {
  const { outputFiles } = await build({
    stdin: {
      contents: `
        import { render } from "svelte/server";
        import Signal from "./web/src/routes/hotzones/[signal]/+page.svelte";
        export function renderSignalKit(data) {
          const result = render(Signal, { props: { data } });
          return '<!doctype html><html><head>' + result.head + '</head><body>' + result.body + '</body></html>';
        }
      `,
      resolveDir: root,
      loader: "js",
    },
    absWorkingDir: root,
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
    tsconfigRaw: { compilerOptions: {} },
    nodePaths: [join(root, "web/node_modules"), join(root, "node_modules")],
    alias: { "#lib": join(root, "web/src/lib") },
    plugins: [
      {
        name: "discovery-signal-title-ssr",
        setup(plugin) {
          plugin.onLoad({ filter: /\.svelte$/ }, ({ path }) => {
            const { js } = compile(readFileSync(path, "utf8"), {
              generate: "server",
              dev: false,
              filename: path,
            });
            return { contents: js.code, loader: "js", resolveDir: dirname(path) };
          });
        },
      },
    ],
  });
  ({ renderSignalKit } = await import(
    `data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString("base64")}`
  ));
});

describe("titleQuery agrees with matchQuery on control input", () => {
  it("treats a NUL-only query as blank, like the search oracle", () => {
    expect(matchQuery("\u0000")).toBeNull();
    expect(eventsTitle({ view: "list", month: "2030-06", q: "\u0000" })).toBe("Events");
  });

  it("preserves the calendar month for a NUL-only query", () => {
    expect(eventsTitle({ view: "calendar", month: "2030-06", q: "\u0000" })).toBe(
      "Events — June 2030",
    );
  });

  it("preserves archive pagination for a NUL-only query", () => {
    expect(pastEventsTitle(1, "\u0000")).toBe("Past events");
    expect(pastEventsTitle(3, "\u0000")).toBe("Past events — page 3");
  });

  it("strips interior NULs the way matchQuery does", () => {
    expect(matchQuery("a\u0000b")).toBe("ab");
    expect(eventsTitle({ view: "list", month: "2030-06", q: "a\u0000b" })).toBe(
      "Events matching “ab”",
    );
    expect(pastEventsTitle(1, "a\u0000b")).toBe("Past events matching “ab”");
  });

  it.each([
    ["a\rb", "a\nb"],
    ["a\r\nb", "a\nb"],
    ["a\u0000b\rc", "ab\nc"],
  ])("normalizes CR/CRLF in %j to match the oracle", (q, normalized) => {
    expect(matchQuery(q)).toBe(normalized);
    expect(eventsTitle({ view: "list", month: "2030-06", q })).toBe(
      `Events matching “${normalized}”`,
    );
    expect(pastEventsTitle(2, q)).toBe(`Past events matching “${normalized}”`);
  });
});

describe("hotzoneSignalTitle", () => {
  it.each([
    ["joins", "all", "joins hot zone"],
    ["voice", "all", "voice hot zone"],
    ["games", "all", "games hot zone"],
    ["joins", "2030-Q2", "joins hot zone — 2030-Q2"],
    ["voice", "2030-06", "voice hot zone — 2030-06"],
    ["games", "2026", "games hot zone — 2026"],
  ])("titles %s for season %s", (signal, season, title) => {
    expect(hotzoneSignalTitle(signal, season)).toBe(title);
    expect(title.length).toBeLessThanOrEqual(70);
  });
});

describe("hot-zone signal page titles", () => {
  const cells = Array.from({ length: 7 }, () => Array(24).fill(0));

  function fixture(signal, season) {
    return {
      appUrl: "https://titles.example.test",
      signal,
      season,
      cells,
      total: 0,
      eventCount: 0,
      retentionNote: null,
      estimated: signal !== "joins",
      gridHtml: renderHotzoneGrid(cells, `Activity for season ${season}`),
      periodPickerHtml: "",
    };
  }

  it.each([
    ["joins", "all", "joins hot zone"],
    ["joins", "2030-Q2", "joins hot zone — 2030-Q2"],
    ["voice", "2030-Q3", "voice hot zone — 2030-Q3"],
    ["games", "2030-06", "games hot zone — 2030-06"],
  ])("renders %s %s identically on both twins", async (signal, season, title) => {
    const data = fixture(signal, season);
    const hono = await HotzoneSignalPage(data).toString();
    const kit = renderSignalKit(data);
    for (const html of [hono, kit]) {
      const match = html.match(/<title>([^<]*)<\/title>/);
      expect(match?.[1]).toBe(`${title} — Together We Own`);
    }
  });

  it("keeps distinct titles for neighbouring seasons", async () => {
    for (const html of [
      await HotzoneSignalPage(fixture("joins", "2030-Q2")).toString(),
      await HotzoneSignalPage(fixture("joins", "2030-Q3")).toString(),
    ]) {
      expect(html).toContain("<title>");
    }
    const q2 = await HotzoneSignalPage(fixture("joins", "2030-Q2")).toString();
    const q3 = await HotzoneSignalPage(fixture("joins", "2030-Q3")).toString();
    expect(q2.match(/<title>([^<]*)<\/title>/)?.[1]).toBe(
      "joins hot zone — 2030-Q2 — Together We Own",
    );
    expect(q3.match(/<title>([^<]*)<\/title>/)?.[1]).toBe(
      "joins hot zone — 2030-Q3 — Together We Own",
    );
  });
});
