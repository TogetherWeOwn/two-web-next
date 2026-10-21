// Failing-first acceptance: overlong Kit past searches answer the 422 notice.
//
// The Kit archive binding throws error(422) for an overlong query, but the
// root error boundary has no 422 entry, so members see the 500 outage shell
// ("Something broke on our side... We have logged the failure.") instead of
// the too-long notice the Hono twin serves. The fix adds the 422 notice to
// the Kit boundary; these tests prove the outcome at the boundary and pin the
// twin and valid-search behavior that must not change.
//
// Builder: build on this branch, never edit this file. RED tests fail on the
// base HEAD without the fix and pass with a correct fix; GREEN controls pass
// before and after. Local fixtures only, no live services, no session or DB
// reads merely to render the notice.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { build } from "esbuild";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetAnonEventCacheForTests } from "../src/events/anon-cache";
import { EVENTS_SEARCH_TOO_LONG_COPY } from "../src/islands/contracts";
import { isKitErrorStatus, kitErrorCopy } from "../src/kit-errors";
import { dispatchPastArchiveRequest, loadPastArchivePage } from "../src/kit-past-events";
import {
  ARCHIVE_NOW,
  ARCHIVE_QUERY,
  archiveReadFixture,
  archiveRow,
  compileArchiveKit,
  eventKeys,
  firstMatchKeys,
  lastMatchKeys,
  requestArchive,
  requestCalendar,
} from "./helpers/past-archive-search-acceptance";

vi.mock("../src/events/search-log", async (original) => ({
  ...(await original<typeof import("../src/events/search-log")>()),
  recordSearch: vi.fn(async () => {}),
}));

const OVERLONG_Q = "x".repeat(300);
const OVERLONG_ASTRAL_Q = "😀".repeat(300);
const OUTAGE_COPY = [
  "Something broke on our side",
  "We will be right back",
  "logged the failure",
  "Events temporarily unavailable",
];
const NOTICE = EVENTS_SEARCH_TOO_LONG_COPY;

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const readSource = (path: string) => readFileSync(join(root, path), "utf8");

let kit: Awaited<ReturnType<typeof compileArchiveKit>>;
let renderErrorShell: (code: number) => { head: string; body: string };

beforeAll(async () => {
  kit = await compileArchiveKit();
  const worktree = fileURLToPath(new URL("../", import.meta.url));
  const webRequire = createRequire(new URL("../web/package.json", import.meta.url));
  const { compile } = webRequire("svelte/compiler") as {
    compile: (
      source: string,
      options: { generate: string; dev: boolean; filename: string },
    ) => { js: { code: string } };
  };
  const scratch = mkdtempSync(join(tmpdir(), "kit-past-422-acceptance-"));
  const entry = join(scratch, "kit-past-422-entry.mjs");
  writeFileSync(
    entry,
    `
import { render } from "svelte/server";
import ErrorShell from ${JSON.stringify(join(worktree, "web/src/lib/ErrorShell.svelte"))};
export function renderErrorShell(code) {
  const { head, body } = render(ErrorShell, { props: { code, inviteUrl: "https://discord.gg/fixture-invite" } });
  return { head, body };
}
`,
  );
  const outfile = join(scratch, "kit-past-422-shell.mjs");
  await build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile,
    logLevel: "warning",
    absWorkingDir: worktree,
    nodePaths: [join(worktree, "web/node_modules"), join(worktree, "node_modules")],
    alias: { "#lib": fileURLToPath(new URL("../web/src/lib/", import.meta.url)) },
    plugins: [
      {
        name: "kit-past-422-svelte-ssr",
        setup(plugin) {
          plugin.onLoad({ filter: /\.svelte$/ }, (args) => {
            const source = readFileSync(args.path, "utf8");
            const { js } = compile(source, {
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
  ({ renderErrorShell } = (await import(pathToFileURL(outfile).href)) as {
    renderErrorShell: (code: number) => { head: string; body: string };
  });
  rmSync(scratch, { recursive: true, force: true });
}, 120_000);

afterAll(() => kit?.dispose());

beforeEach(() => {
  __resetAnonEventCacheForTests();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(ARCHIVE_NOW);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function privateNoStore(response: Response) {
  const cache = response.headers.get("cache-control") ?? "";
  expect(cache).toContain("private");
  expect(cache).toContain("no-store");
  expect(cache).not.toContain("public");
  expect(response.headers.get("x-two-past-cacheable")).toBeNull();
}

describe("RED: Kit past overlong answers the 422 notice", () => {
  it("knows 422 as a Kit error status", () => {
    expect(isKitErrorStatus(422)).toBe(true);
  });

  it("answers 422 with the too-long notice, never outage copy", () => {
    expect(isKitErrorStatus(422)).toBe(true);
    const copy = kitErrorCopy(422 as never);
    expect(copy.code).toBe("422");
    expect(copy.lead).toBe(NOTICE);
    expect(copy.title.length).toBeGreaterThan(0);
    expect(copy.title).toBe("Events");
    for (const outage of OUTAGE_COPY) {
      expect(copy.title).not.toContain(outage);
      expect(copy.lead).not.toContain(outage);
    }
  });

  it("ErrorShell source handles the 422 notice branch", () => {
    const shell = readSource("web/src/lib/ErrorShell.svelte");
    expect(shell).toContain("422");
    expect(shell).toContain("kitErrorCopy");
  });

  it("ErrorShell renders 422 with the notice, no outage copy, no query echo", () => {
    expect(isKitErrorStatus(422)).toBe(true);
    let rendered: { head: string; body: string } | undefined;
    expect(() => {
      rendered = renderErrorShell(422);
    }).not.toThrow();
    const html = `${rendered!.head}\n${rendered!.body}`;
    expect(html).toContain(NOTICE);
    expect(html).toContain('aria-hidden="true">422<');
    for (const outage of OUTAGE_COPY) expect(html).not.toContain(outage);
    expect(html).not.toContain(OVERLONG_Q);
    expect(html).not.toContain(OVERLONG_ASTRAL_Q);
    expect(html).toContain("data-testid=");
  });

  it("422 SSR offers exactly events and home recovery, never 503 invite/retry actions", () => {
    const { head, body } = renderErrorShell(422);
    expect(head).toContain("<title>Events — Together We Own</title>");
    expect(body).toContain('<h1 id="error-heading">Events</h1>');
    const main = body.match(/<main\b[^>]*>([\s\S]*?)<\/main>/)?.[1];
    expect(main).toBeDefined();
    const links = [...main!.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)].map(([, attrs, content]) => ({
      testid: attrs!.match(/data-testid="([^"]*)"/)?.[1],
      href: attrs!.match(/href="([^"]*)"/)?.[1],
      text: content!
        .replace(/<!--[\s\S]*?-->/g, "")
        .replace(/\s+/g, " ")
        .trim(),
    }));
    expect(links).toEqual([
      { testid: "error-events", href: "/events", text: "Back to events" },
      { testid: "error-home", href: "/", text: "Back to the homepage" },
    ]);
    expect(main).not.toContain('data-testid="error-invite"');
    expect(main).not.toContain('data-testid="error-retry"');
  });

  it("root boundary preserves 422 instead of falling back to the 500 shell", async () => {
    const page = readSource("web/src/routes/+error.svelte");
    expect(page).toContain(
      "const status = $derived(isKitErrorStatus(page.status) ? page.status : 500);",
    );
    expect(page).toContain('<meta name="robots" content="noindex, nofollow" />');
    const status = isKitErrorStatus(422) ? 422 : 500;
    expect(status).toBe(422);
    const copy = kitErrorCopy(status as never);
    expect(copy.lead).toBe(NOTICE);
    for (const outage of OUTAGE_COPY) {
      expect(copy.title).not.toContain(outage);
      expect(copy.lead).not.toContain(outage);
    }
  });

  it("Kit overlong composition stays 422 with private no-store and no outage copy", () => {
    const binding = readSource("web/src/routes/events/past/+page.server.ts");
    expect(binding).toContain("error(422, EVENTS_SEARCH_TOO_LONG_COPY)");
    expect(binding).toContain('"cache-control": "private, no-store"');
    const status = isKitErrorStatus(422) ? 422 : 500;
    expect(status).toBe(422);
    const copy = kitErrorCopy(status as never);
    expect(copy.lead).toBe(NOTICE);
    let rendered: { head: string; body: string } | undefined;
    expect(() => {
      rendered = renderErrorShell(status);
    }).not.toThrow();
    const html = `${rendered!.head}\n${rendered!.body}`;
    expect(html).toContain(NOTICE);
    for (const outage of OUTAGE_COPY) expect(html).not.toContain(outage);
    expect(html).not.toContain(OVERLONG_Q);
  });
});

describe("GREEN: binding, helper and dispatch pins", () => {
  it("binding admits only raw oversized input before reads, helper owns the 503 map", () => {
    const binding = readSource("web/src/routes/events/past/+page.server.ts");
    expect(binding).toContain("MAX_QUERY_LENGTH");
    expect(binding).toContain('error(503, "Events temporarily unavailable")');
    expect(binding).toContain('pageParam: url.searchParams.get("page")');
    expect(binding).toContain("dbForFn: dbFor");
    expect(binding).toContain("listPastFn: listPast");
  });

  it("helper rejects a 300-char query before touching the database", async () => {
    const headers: Record<string, string> = {};
    const dbForFn = vi.fn(async () => ({}) as never);
    const listPastFn = vi.fn(async () => ({ rows: [], hasMore: false, totalPages: 0 }));
    for (const queryParam of [OVERLONG_Q, OVERLONG_ASTRAL_Q, " ".repeat(300)]) {
      await expect(
        loadPastArchivePage({
          env: { APP_URL: "https://example.test" } as never,
          pageParam: "1",
          queryParam,
          setHeaders: (next) => Object.assign(headers, next),
          dbForFn,
          listPastFn,
        }),
      ).rejects.toMatchObject({ status: 422 });
    }
    expect(headers["cache-control"]).toBe("private, no-store");
    expect(headers["x-two-past-cacheable"]).toBeUndefined();
    expect(dbForFn).not.toHaveBeenCalled();
    expect(listPastFn).not.toHaveBeenCalled();
  });

  it("dispatch bypasses the guard and cache for overlong archive input", async () => {
    const guard = vi.fn(async () => null);
    const resolveFn = vi.fn(
      async () =>
        new Response(NOTICE, {
          status: 422,
          headers: { "cache-control": "private, no-store" },
        }),
    );
    const response = await dispatchPastArchiveRequest(
      new Request(`https://example.test/events/past?q=${OVERLONG_Q}`),
      { APP_URL: "https://example.test" } as never,
      resolveFn,
      guard,
      1000,
    );
    expect(response.status).toBe(422);
    expect(guard).not.toHaveBeenCalled();
    expect(resolveFn).toHaveBeenCalledOnce();
    privateNoStore(response);
    expect(await response.text()).toContain(NOTICE);
  });
});

describe("GREEN: overlong twins stay notice plus 422", () => {
  it("Hono past answers 300 chars with the notice, no echo, no outage", async () => {
    const source = archiveReadFixture();
    const response = await requestArchive(
      "Hono",
      `/events/past?${new URLSearchParams({ q: OVERLONG_Q })}`,
      source.env,
      kit,
    );
    expect(response.status).toBe(422);
    privateNoStore(response);
    expect(source.statements).toEqual([]);
    const body = await response.text();
    expect(body).toContain(NOTICE);
    expect(body).not.toContain(OVERLONG_Q);
    for (const outage of OUTAGE_COPY) expect(body).not.toContain(outage);
  });

  it("Kit events answers 300 chars with the notice and 422, no echo", async () => {
    const source = archiveReadFixture();
    const response = await requestCalendar(
      "Kit",
      `/events?${new URLSearchParams({ q: OVERLONG_Q })}`,
      source.env,
      kit,
    );
    expect(response.status).toBe(422);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("cache-control")).toContain("private");
    const body = await response.text();
    expect(body).toContain(NOTICE);
    expect(body).not.toContain(OVERLONG_Q);
    for (const outage of OUTAGE_COPY) expect(body).not.toContain(outage);
  });

  it("Hono events answers 300 chars with the notice and 422, no echo", async () => {
    const source = archiveReadFixture();
    const response = await requestCalendar(
      "Hono",
      `/events?${new URLSearchParams({ q: OVERLONG_Q })}`,
      source.env,
      kit,
    );
    expect(response.status).toBe(422);
    const body = await response.text();
    expect(body).toContain(NOTICE);
    expect(body).not.toContain(OVERLONG_Q);
    for (const outage of OUTAGE_COPY) expect(body).not.toContain(outage);
  });
});

describe.each(["Hono", "Kit"] as const)("GREEN: %s valid archive behavior unchanged", (twin) => {
  const searchPath = (q = ARCHIVE_QUERY, page = 1) =>
    `/events/past?${new URLSearchParams({ q, page: String(page) })}`;

  it("filters before paging: 25 matches across 20 plus 5, private no-store", async () => {
    const source = archiveReadFixture();
    const first = await requestArchive(twin, searchPath(), source.env, kit);
    const second = await requestArchive(twin, searchPath(ARCHIVE_QUERY, 2), source.env, kit);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(eventKeys(await first.text())).toEqual(firstMatchKeys);
    expect(eventKeys(await second.text())).toEqual(lastMatchKeys);
    privateNoStore(first);
    privateNoStore(second);
  });

  it("separates a miss from an ordinary page and keeps blanks ordinary", async () => {
    const source = archiveReadFixture();
    const miss = await requestArchive(twin, searchPath("no such meeting"), source.env, kit);
    expect(miss.status).toBe(200);
    expect(eventKeys(await miss.text())).toEqual([]);
    privateNoStore(miss);
    const blank = await requestArchive(twin, searchPath("  "), source.env, kit);
    expect(blank.status).toBe(200);
    expect(eventKeys(await blank.text())).toHaveLength(20);
    expect(blank.headers.get("cache-control")).toContain("public");
  });

  it("keeps the ordinary 20-row archive publicly cacheable", async () => {
    const source = archiveReadFixture();
    const first = await requestArchive(twin, "/events/past", source.env, kit);
    const body = await first.text();
    expect(first.status).toBe(200);
    expect(eventKeys(body)).toHaveLength(20);
    expect(body).toContain('data-total-pages="3"');
    expect(first.headers.get("cache-control")).toContain("public");
    source.statements.length = 0;
    expect(await (await requestArchive(twin, "/events/past", source.env, kit)).text()).toBe(body);
    expect(source.statements).toEqual([]);
  });

  it("admits a 255-char query without truncation", async () => {
    const source = archiveReadFixture();
    const q = "y".repeat(255);
    source.replaceRows([
      archiveRow(200, { eventKey: "boundary-target", title: q }),
      archiveRow(199, { eventKey: "truncation-decoy", title: q.slice(0, -1) }),
    ]);
    const response = await requestArchive(twin, searchPath(q), source.env, kit);
    expect(response.status).toBe(200);
    expect(eventKeys(await response.text())).toEqual(["boundary-target"]);
    privateNoStore(response);
  });
});
