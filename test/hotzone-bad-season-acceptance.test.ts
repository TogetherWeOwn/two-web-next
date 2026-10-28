// route-inventory: GET /hotzones
// route-inventory: GET /hotzones/:signal
// Acceptance (test files only): a bad `?season=` on the hot-zone pages
// answers an honest branded 400 on both twins — never bare text, never the
// 500 shell.
//
// Contract lock-in (Test Author). The Builder implements against this file;
// nothing here may change to make an implementation pass.
//
// Today Hono answers a bad season with bare text (`c.text("Unknown
// season", 400)` in src/hotzones/routes.tsx — no shell, no nav) on all four
// paths, and Kit throws `error(400, …)` into an error boundary whose status
// vocabulary (src/kit-errors.ts) has no 400, so the boundary's
// unknown-status fallback renders the 500 shell ("Something broke on our
// side") at HTTP 400. Production serves hot zones from Kit, so the lying
// shell is the live one.
//
// The contract, both twins:
// - Hono `/hotzones`, `/hotzones/joins`, `/hotzones/voice` and
//   `/hotzones/games` with a bad `?season=` answer status 400 with the
//   branded error shell: site chrome (brand + footer), the decorative
//   recovery code `400`, the shared 400 title as the page heading, recovery
//   navigation back home, and noindex — with no grid/table, zero shared
//   public-read throttle spend and zero DB opens (so zero aggregate reads
//   and zero board-view inserts), exactly as the grammar-first order in
//   docs/event-read-admission.md already requires.
// - Kit gains 400 as a first-class error status: `isKitErrorStatus(400)`
//   is true, `kitErrorCopy(400)` carries code "400" with honest client-error
//   copy (never the 500/"broke on our side" or 503 outage copy), and
//   ErrorShell.svelte has its own 400 branch (the 503 `{:else}` branch must
//   not swallow it). The boundary expression
//   `isKitErrorStatus(page.status) ? page.status : 500` then renders the
//   400 shell at HTTP 400.
// - Parity of bodies, not just status: the Hono 400 heading is byte-equal
//   to the Kit copy title (kit-errors.ts is the data twin of the Hono
//   shells: "byte-identical titles"), and neither body carries the 500
//   title. The exact 400 wording is the Builder's choice; the twins must
//   agree on it.
// - Positive controls stay green: valid seasons render 200 with the public
//   cache headers, an unknown signal answers 404, and the Kit loads still
//   reject a bad season with { status: 400 } before any database work.
//
// How this fails before the Builder lands: every branded-body case fails —
// Hono returns the bare "Unknown season" text (no shell, no recovery code,
// no recovery nav) and the Kit vocabulary has no 400, so the boundary
// semantics resolve 400 to the 500 shell. Representation mutants (bare-text
// branch restored; 400 dropped from the Kit vocabulary or its shell branch)
// fail these tests. Hermetic doubles only: no live DB, no network.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";
import { emptyGrid } from "../src/hotzones/aggregates";
import { registerHotzoneRoutes } from "../src/hotzones/routes";
import { isKitErrorStatus, kitErrorCopy, type KitErrorStatus } from "../src/kit-errors";
import { loadHotzonesIndexData } from "../src/kit-hotzones";
import type { Sql } from "../src/sessions";
import type { EnvWithThrottle } from "../src/throttle";

const PATHS = ["/hotzones", "/hotzones/joins", "/hotzones/voice", "/hotzones/games"];
const IP = "192.0.2.23";
const APP_URL = "https://next.example.test";
const BAD_SEASONS = ["not-a-season", "2026-13", "2026-Q5", ""];

// Mirrors the statement-double fixture in
// test/hotzone-read-admission-acceptance.test.ts: the real admission
// transaction runs against local doubles so a throttle spend is observable,
// and every ADMIN_DB reach is counted — a board-view insert cannot happen
// without one.
function fixture() {
  let now = Date.now();
  const hits: { bucket: string; at: number }[] = [];
  const sql = Object.assign(
    async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const statement = strings.join("?");
      if (statement.includes("pg_advisory_xact_lock")) return [];
      if (statement.includes("SELECT count(*)")) {
        const rows = hits.filter((hit) => hit.bucket === values[0] && hit.at > now - 60_000);
        return [
          {
            n: rows.length,
            wait: rows.length ? Math.ceil((rows[0]!.at + 60_000 - now) / 1000) : 1,
          },
        ];
      }
      if (statement.includes("INSERT INTO web_throttle_hits")) {
        hits.push({ bucket: String(values[0]), at: now });
        return [];
      }
      if (statement.includes("DELETE FROM web_throttle_hits")) return [];
      throw new Error("Unexpected throttle statement");
    },
    {
      begin: (run: (tx: Sql) => Promise<unknown>) => run(sql as unknown as Sql),
      unsafe: async () => [],
    },
  );
  const throttleStore = vi.fn(async () => sql as unknown as Sql);
  const transaction = vi.fn(async () => {
    throw new Error("hot-zone DB touched on a bad-season answer");
  });
  const poisonDb = { transaction } as unknown as Db;
  let currentDb: Db | null = null;
  const eventStore = vi.fn(() => currentDb);
  const app = new Hono<{ Bindings: Env }>();
  registerHotzoneRoutes(app);
  const env = {
    APP_URL,
    THROTTLE_STORE: throttleStore,
    get ADMIN_DB() {
      return eventStore();
    },
  } as unknown as EnvWithThrottle;
  const request = (path: string, init: RequestInit = {}) =>
    app.request(path, { ...init, headers: { "cf-connecting-ip": IP, ...init.headers } }, env);
  return {
    request,
    hits,
    throttleStore,
    eventStore,
    transaction,
    poison: () => {
      currentDb = poisonDb;
    },
  };
}

// The branded-shell body contract, shared by every Hono case and mirrored
// (as data) by the Kit cases below. Copy wording beyond the twin-agreed
// title is the Builder's; structure and honesty are not.
function expectBranded400(body: string, label: string) {
  // Never the bare-text answer and never the outage shells.
  expect(body.trim(), label).not.toBe("Unknown season");
  expect(body, label).not.toContain("Something broke on our side");
  expect(body, label).not.toContain("We will be right back");
  // Site shell: full document with the site chrome and footer nav.
  expect(body, label).toContain("<html");
  expect(body, label).toContain("Together We Own");
  expect(body, label).toContain('href="/about"');
  // The branded recovery treatment: decorative 400 code + noindex.
  expect(body, label).toMatch(/class="recovery-code(?:\s[^"]*)?"[^>]*>\s*400\s*</);
  expect(body, label).toContain("noindex, nofollow");
  // Recovery navigation: a named way back home.
  expect(body, label).toContain('data-testid="error-home"');
  expect(body, label).toContain("Back to the homepage");
  // No board leaked into the refusal.
  expect(body, label).not.toContain("<table");
}

const copy400 = () => kitErrorCopy(400 as KitErrorStatus);

describe("hot-zone bad season (Hono branded 400)", () => {
  it.each(PATHS)(
    "answers %s?season=not-a-season with the branded 400 and spends nothing",
    async (path) => {
      const f = fixture();
      f.poison();
      const response = await f.request(`${path}?season=not-a-season`, {
        headers: { accept: "text/html" },
      });
      expect(response.status, path).toBe(400);
      expect(response.headers.get("content-type"), path).toContain("text/html");
      expectBranded400(await response.text(), path);
      // Grammar first: zero throttle spend, zero DB opens (zero board-view
      // inserts), zero aggregate transactions.
      expect(f.hits, path).toHaveLength(0);
      expect(f.throttleStore, path).not.toHaveBeenCalled();
      expect(f.eventStore, path).not.toHaveBeenCalled();
      expect(f.transaction, path).not.toHaveBeenCalled();
    },
  );

  it.each(BAD_SEASONS)(
    "answers every bad-season spelling (%j) branded on index and signal alike",
    async (season) => {
      const f = fixture();
      f.poison();
      for (const path of ["/hotzones", "/hotzones/joins"]) {
        const response = await f.request(`${path}?season=${encodeURIComponent(season)}`);
        expect(response.status, `${path} season=${season}`).toBe(400);
        expectBranded400(await response.text(), `${path} season=${season}`);
      }
      expect(f.hits).toHaveLength(0);
      expect(f.throttleStore).not.toHaveBeenCalled();
      expect(f.eventStore).not.toHaveBeenCalled();
    },
  );
});

describe("hot-zone bad season (Kit honest 400)", () => {
  it("admits 400 to the Kit error vocabulary with honest client-error copy", () => {
    expect(isKitErrorStatus(400)).toBe(true);
    const copy = copy400();
    expect(copy?.code).toBe("400");
    expect(copy?.title).toBeTruthy();
    expect(copy?.lead).toBeTruthy();
    // Honest: the 400 copy is its own, never the 500 or 503 wording.
    expect(copy?.title).not.toBe(kitErrorCopy(500).title);
    expect(copy?.title).not.toBe(kitErrorCopy(503).title);
    expect(copy?.lead).not.toBe(kitErrorCopy(500).lead);
    expect(copy?.lead).not.toBe(kitErrorCopy(503).lead);
    expect(`${copy?.title} ${copy?.lead}`).not.toContain("broke on our side");
    expect(`${copy?.title} ${copy?.lead}`).not.toContain("It is not you");
  });

  it("resolves HTTP 400 through the boundary fallback expression to the 400 shell, never 500", () => {
    // Same evaluation precedent as test/kit-errors-outcome.test.ts: the root
    // suite cannot transform Svelte, so pin the boundary source expression
    // and evaluate its semantics for 400.
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const page = readFileSync(resolve(root, "web/src/routes/+error.svelte"), "utf8");
    expect(page).toContain(
      "const status = $derived(isKitErrorStatus(page.status) ? page.status : 500);",
    );
    const status = isKitErrorStatus(400) ? 400 : 500;
    expect(status).toBe(400);
    expect(copy400()?.code).toBe("400");
  });

  it("gives ErrorShell its own 400 branch so the 503 fallthrough cannot swallow it", () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const shell = readFileSync(resolve(root, "web/src/lib/ErrorShell.svelte"), "utf8");
    expect(shell).toMatch(/code === 400/);
    // The 400 branch still offers the recovery way home, like every shell.
    const branch = shell.slice(shell.search(/code === 400/));
    expect(branch).toContain('data-testid="error-home"');
  });

  it("keeps the Kit load rejecting a bad season with 400 before any database work", async () => {
    const dbForFn = vi.fn(async () => null);
    const loadJoinsGridFn = vi.fn(async () => ({ cells: emptyGrid(), total: 0, eventCount: 0 }));
    const recordBoardViewFn = vi.fn(async () => {});
    await expect(
      loadHotzonesIndexData({
        env: { APP_URL } as never,
        seasonParam: "not-a-season",
        setHeaders: vi.fn(),
        dbForFn,
        loadJoinsGridFn,
        recordBoardViewFn,
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(dbForFn).not.toHaveBeenCalled();
    expect(loadJoinsGridFn).not.toHaveBeenCalled();
    expect(recordBoardViewFn).not.toHaveBeenCalled();
  });
});

describe("hot-zone bad season (twin parity of bodies)", () => {
  it("renders the same 400 title and code on the Hono body as the Kit copy carries", async () => {
    const f = fixture();
    const copy = copy400();
    expect(copy?.title).toBeTruthy();
    for (const path of PATHS) {
      const response = await f.request(`${path}?season=bogus`, {
        headers: { accept: "text/html" },
      });
      expect(response.status, path).toBe(400);
      const body = await response.text();
      const heading = /<h1 id="error-heading">([^<]+)<\/h1>/.exec(body)?.[1];
      expect(heading, path).toBe(copy.title);
      expect(body, path).toContain(`<title>${copy.title} — Together We Own</title>`);
      expect(body, path).toMatch(
        new RegExp(`class="recovery-code(?:\\s[^"]*)?"[^>]*>\\s*${copy.code}\\s*<`),
      );
    }
  });
});

describe("hot-zone bad-season positive controls", () => {
  it.each(["all", "2026", "2026-09", "2026-Q3"])(
    "still renders a valid ?season=%s as a cached 200 board",
    async (season) => {
      const f = fixture();
      const response = await f.request(`/hotzones?season=${season}`);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("public, max-age=300");
      expect(response.headers.get("vary")).toBe("Cookie");
      expect(response.headers.get("content-type")).toContain("text/html");
      expect(await response.text()).toContain("<table");
    },
  );

  it("still answers an unknown signal with 404 and no spend", async () => {
    const f = fixture();
    const response = await f.request("/hotzones/bogus?season=2026");
    expect(response.status).toBe(404);
    expect(f.hits).toHaveLength(0);
    expect(f.throttleStore).not.toHaveBeenCalled();
    expect(f.eventStore).not.toHaveBeenCalled();
  });
});
