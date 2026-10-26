// route-inventory: GET /leaderboards/members
// route-inventory: GET /admin/events/new
// route-inventory: GET /admin/events/:key
// route-inventory: POST /admin/events
// route-inventory: POST /admin/events/:key
// Independent acceptance contract. Incorporate unchanged with the implementation.
// U5-R* catches missing/unsafe assistance; U5-N* catches boundary regressions;
// U5-C* protects existing behavior. Only persistence/Workers transport is doubled.
import { beforeAll, afterEach, describe, expect, it, vi } from "vitest";
import app from "./app";
import { listPublishedGames } from "../src/events/reads";
import { parseEventForm } from "../src/admin/validation";
import {
  ORIGIN,
  KEY,
  HOSTILE,
  PUBLISHED,
  fixtureDb,
  fixtureEnv,
  gameControl,
  attr,
  text,
  cacheTokens,
  outage,
  compileSuggestionKit,
} from "./helpers/game-input-suggestions.mjs";

let kit;
beforeAll(async () => {
  kit = await compileSuggestionKit();
});
afterEach(() => {
  vi.restoreAllMocks();
});
const surfaces = [
  { surface: "board", path: "/leaderboards/members", name: "activity" },
  { surface: "create", path: "/admin/events/new", name: "game" },
  { surface: "edit", path: `/admin/events/${KEY}`, name: "game" },
];

async function document(twin, surface, options = {}) {
  const fixture = fixtureDb(options);
  const { env, cookie } = await fixtureEnv(fixture.db, options);
  const path = options.path ?? surfaces.find((s) => s.surface === surface).path;
  let response, data;
  if (twin === "Kit") ({ response, data } = await kit.request({ surface, env, path, ...options }));
  else
    response = await app.request(
      path,
      { headers: { cookie, accept: "text/html,application/xhtml+xml" } },
      env,
    );
  return { ...fixture, env, cookie, data, response, html: await response.text() };
}

function expectNative(html, name) {
  const control = gameControl(html, name);
  expect(
    control.input,
    "U5_ASSISTANCE_INPUT_MISSING: retain the existing editable game field",
  ).toBeDefined();
  expect(attr(control.input, "type")).toBe("text");
  expect(
    attr(control.input, "list"),
    "U5_ASSISTANCE_MISSING: connect the native input to published names",
  ).toBeTruthy();
  expect(
    control.list,
    "U5_ASSISTANCE_TARGET_MISSING: render the referenced datalist",
  ).toBeDefined();
  expect(control.all.filter((n) => attr(n, "id") === attr(control.input, "list"))).toHaveLength(1);
  const label = control.all.find(
    (n) => n.tagName === "label" && attr(n, "for") === attr(control.input, "id"),
  );
  expect(text(label)).toMatch(/game/i);
  expect(attr(control.input, "onchange")).toBeUndefined();
  expect(attr(control.input, "oninput")).toBeUndefined();
  return control;
}

function expectCatalogBudget(fixture, surface) {
  expect(
    fixture.catalogReads(),
    "U5_CATALOG_SNAPSHOT: reuse exactly one catalog read per assisted document",
  ).toHaveLength(1);
  const memberReads = fixture.statements.filter(
    (s) => /^select/i.test(s.sql.trim()) && /from\s+"?rsvps"?/i.test(s.sql),
  );
  expect(
    memberReads,
    "U5_MEMBER_READ_BUDGET: assistance must not fetch members or issue per-option reads",
  ).toHaveLength(surface === "board" ? 1 : surface === "edit" ? 2 : 0);
  const primaryReads = fixture.statements.filter(
    (s) =>
      /^select/i.test(s.sql.trim()) &&
      !/^select set_config/i.test(s.sql.trim()) &&
      !fixture.catalogReads().includes(s),
  );
  expect(primaryReads, "U5_TOTAL_READ_BUDGET: hints must not add user/profile reads").toHaveLength(
    surface === "board" ? 1 : surface === "edit" ? 3 : 0,
  );
  const writes = fixture.statements.filter((s) => /^(insert|update|delete)/i.test(s.sql.trim()));
  expect(writes.every((s) => /"(member_data_access_logs|board_view_logs)"/.test(s.sql))).toBe(true);
  expect(cacheTokens(fixture.response)).toEqual(["no-store", "private"]);
}

describe("U5 published names at the real catalog SQL boundary", () => {
  it("U5-C01 preserves historical-only spellings, variants and the published-only bounded query", async () => {
    const f = fixtureDb();
    expect((await listPublishedGames(f.db)).sort()).toEqual([...PUBLISHED].sort());
    expect(f.catalogReads()).toHaveLength(1);
    const query = f.catalogReads()[0];
    expect(query.sql).toMatch(/status"?\s*=\s*'published'/);
    expect(query.sql).toMatch(/game"? is not null/i);
    expect(query.sql).toMatch(/trim\([^)]*game[^)]*\) <> ''/i);
    expect(query.sql).toMatch(/order by/i);
    expect(query.sql).not.toMatch(/starts_at|ends_at|rsvps|users/i);
    const limit = Number(/limit \$(\d+)/i.exec(query.sql)?.[1]);
    expect(query.params[limit - 1]).toBe(100);
  });
});

for (const twin of ["Hono", "Kit"]) {
  for (const { surface, name } of surfaces) {
    describe(`U5 ${twin} ${surface}`, () => {
      it("U5-R01 offers literal published spellings through one labelled native datalist", async () => {
        const f = await document(twin, surface);
        expect(f.response.status).toBe(200);
        const c = expectNative(f.html, name);
        expect([...c.values].sort()).toEqual([...PUBLISHED].sort());
        expect(c.values).not.toContain("PRIVATE DRAFT CANARY");
        expect(c.values).not.toContain("CANCELLED CANARY");
        expect(c.all.filter((n) => n.tagName === "img" && attr(n, "src") === "x")).toEqual([]);
        const helpIds = (attr(c.input, "aria-describedby") ?? "").split(/\s+/);
        const guidance = helpIds
          .map((id) => text(c.all.find((n) => attr(n, "id") === id)))
          .join(" ");
        expect(
          guidance,
          "U5_GUIDANCE_MISSING: explain that suggestions are published names, not attendance or availability",
        ).toMatch(/published/i);
        expectCatalogBudget(f, surface);
        expect(JSON.stringify(f.data ?? {})).not.toContain("PRIVATE DRAFT CANARY");
      });

      it("U5-C05 preserves existing primary read counts and performs no user/profile/game writes", async () => {
        const f = await document(twin, surface);
        expect(f.response.status).toBe(200);
        const reads = f.statements.filter(
          (s) =>
            /^select/i.test(s.sql.trim()) &&
            !/^select set_config/i.test(s.sql.trim()) &&
            !f.catalogReads().includes(s),
        );
        expect(reads).toHaveLength(surface === "board" ? 1 : surface === "edit" ? 3 : 0);
        expect(
          f.statements
            .filter((s) => /^(insert|update|delete)/i.test(s.sql.trim()))
            .every((s) => /"(member_data_access_logs|board_view_logs)"/.test(s.sql)),
        ).toBe(true);
      });

      it("U5-R02 caps assistance at the existing 100-game snapshot without per-option reads", async () => {
        const catalog = Array.from({ length: 125 }, (_, i) => ({
          game: `Game ${String(i).padStart(3, "0")}`,
          status: "published",
        }));
        const f = await document(twin, surface, { catalog });
        expect(f.response.status).toBe(200);
        expect(expectNative(f.html, name).values).toHaveLength(100);
        expectCatalogBudget(f, surface);
      });

      it("U5-R03 classified catalog failure leaves the existing board/editor usable", async () => {
        const f = await document(twin, surface, { catalogError: outage() });
        expect(
          f.response.status,
          "U5_CATALOG_OPTIONAL: classify the optional read without refusing the primary page",
        ).toBe(200);
        const c = gameControl(f.html, name);
        expect(c.input).toBeDefined();
        expect(c.values).toEqual([]);
        expect(
          f.catalogReads(),
          "U5_OUTAGE_EXERCISED: do not make the fallback test vacuous",
        ).toHaveLength(1);
        expect(cacheTokens(f.response)).toEqual(["no-store", "private"]);
        if (surface === "board") expect(f.html).toContain("Fixture member");
        else
          expect(c.all.some((n) => n.tagName === "form" && attr(n, "method") === "post")).toBe(
            true,
          );
      });

      it("U5-R04 an unrelated catalog bug is not swallowed as optional-source absence", async () => {
        class CatalogProgrammingBug extends Error {}
        const logs = vi.spyOn(console, "error").mockImplementation(() => {});
        const f = await document(twin, surface, {
          catalogError: new CatalogProgrammingBug("private fixture details"),
        });
        expect(f.catalogReads(), "U5_BUG_EXERCISED: execute the failing catalog read").toHaveLength(
          1,
        );
        expect(f.response.status).toBeGreaterThanOrEqual(500);
        const diagnostics = logs.mock.calls.flat().map(String).join("\n");
        expect(
          diagnostics,
          "U5_BUG_DIAGNOSTIC: preserve the existing redacted error alert",
        ).toContain('"event":"error.alert"');
        expect(diagnostics).not.toContain("private fixture details");
        expect(gameControl(f.html, name).values).toEqual([]);
      });

      it("U5-N01 guest/non-admitted requests cannot discover the catalog or add reads", async () => {
        for (const actor of [
          { guest: true },
          surface === "board" ? { member: false } : { moderator: false },
        ]) {
          const f = await document(twin, surface, actor);
          expect(f.response.status).toBe(actor.guest ? 302 : 403);
          expect(f.statements).toEqual([]);
          expect(gameControl(f.html, name).values).toEqual([]);
        }
      });

      it("U5-N02 an audit failure still refuses the member document", async () => {
        const f = await document(twin, surface, { auditError: outage() });
        if (surface === "create") {
          // A blank create form never reads another member: preserve that
          // boundary instead of inventing a subject/audit dependency for hints.
          expect(f.response.status).toBe(200);
          expect(
            f.statements.some((s) => /insert into "member_data_access_logs"/.test(s.sql)),
          ).toBe(false);
        } else {
          expect(f.response.status).toBe(503);
          expect(gameControl(f.html, name).input).toBeUndefined();
          expect(f.html).not.toContain(HOSTILE);
        }
        expect(cacheTokens(f.response)).toEqual(["no-store", "private"]);
      });
    });
  }

  it(`U5-N03 ${twin} invalid board filters refuse before any SQL, including assistance`, async () => {
    for (const query of [
      "season=bad",
      "scope=bad",
      `activity=${"a".repeat(101)}`,
      "activity=Chess%00",
    ]) {
      const f = await document(twin, "board", { path: `/leaderboards/members?${query}` });
      expect(f.response.status).toBe(400);
      expect(f.statements).toEqual([]);
      expect(cacheTokens(f.response)).toEqual(["no-store", "private"]);
    }
  });

  it(`U5-C02 ${twin} assistance never turns All, unknown or Unicode names into a catalog allowlist`, async () => {
    for (const [raw, want] of [
      ["All", "all"],
      ["  Brand-new & 雪  ", "brand-new & 雪"],
      ["D&D", "d&d"],
      ["Z".repeat(100), "z".repeat(100)],
    ]) {
      const f = await document(twin, "board", {
        path: `/leaderboards/members?season=2099&activity=${encodeURIComponent(raw)}`,
      });
      expect(f.response.status).toBe(200);
      expect(attr(gameControl(f.html, "activity").input, "value")).toBe(want);
      const rank = f.statements.find((s) => s.sql.includes("from rsvps"));
      expect(rank.params).toContain(want);
      expect(f.html).toContain("Fixture member");
      expect(
        gameControl(f.html, "activity").all.find(
          (n) => n.tagName === "input" && attr(n, "name") === "season",
        ),
      ).toBeDefined();
    }
  });
}

it("U5-C06 moderator parser keeps valid unlisted names, literal All, Unicode and the 100-character edge", () => {
  for (const [game, expected] of [
    ["  Brand-new & 雪  ", "Brand-new & 雪"],
    ["All", "All"],
    ["D&D", "D&D"],
    [HOSTILE, HOSTILE],
    ["Z".repeat(100), "Z".repeat(100)],
  ]) {
    const parsed = parseEventForm({
      title: "Local game night",
      game,
      starts_at: "2099-06-01 18:00",
      ends_at: "2099-06-01 20:00",
      timezone: "UTC",
      location: "Hall",
    });
    expect(parsed.game).toBe(expected);
  }
});

for (const mode of ["create", "edit"]) {
  it(`U5-R05 Hono ${mode} 422 preserves the exact submitted game and its validation association`, async () => {
    const f = fixtureDb();
    const { env, cookie } = await fixtureEnv(f.db);
    const raw = `  ${HOSTILE}${"x".repeat(101)}  `;
    const path = mode === "create" ? "/admin/events" : `/admin/events/${KEY}`;
    const response = await app.request(
      path,
      {
        method: "POST",
        headers: { cookie, origin: ORIGIN, accept: "text/html" },
        body: new URLSearchParams({
          title: "Draft",
          game: raw,
          starts_at: "2099-06-01 18:00",
          ends_at: "2099-06-01 20:00",
          timezone: "UTC",
          location: "Hall",
        }),
      },
      env,
    );
    expect(response.status).toBe(422);
    const html = await response.text();
    const c = gameControl(html, "game");
    expect(attr(c.input, "value")).toBe(raw);
    expect(attr(c.input, "aria-invalid")).toBe("true");
    const ids = (attr(c.input, "aria-describedby") ?? "").split(/\s+/);
    expect(
      ids.some((id) => c.all.some((n) => attr(n, "id") === id && /100|long/i.test(text(n)))),
    ).toBe(true);
    expect(
      c.all.some((n) => n.tagName === "form" && attr(n, "data-event-draft") !== undefined),
    ).toBe(true);
    expect(
      f.statements.some((s) =>
        /^(insert|update|delete).*"(events|users|user_games|activity_log)"/i.test(s.sql),
      ),
    ).toBe(false);
    expect(f.catalogReads().length).toBeLessThanOrEqual(1);
  });

  it(`U5-C03 Kit ${mode} rejected view retains its draft and field association alongside assistance data`, async () => {
    const f = await document("Kit", mode);
    expect(f.response.status).toBe(200);
    const raw = `  ${HOSTILE}  `;
    const errors = { game: "Game must be at most 100 characters" };
    const rejected =
      mode === "create"
        ? {
            ...f.data,
            values: { ...f.data.values, game: raw },
            errors,
            hasErrors: true,
            isDraft: true,
          }
        : {
            ...f.data,
            view: {
              ...f.data.view,
              values: { ...f.data.view.values, game: raw },
              errors,
              hasErrors: true,
              isDraft: true,
            },
          };
    const c = gameControl(kit.html(mode, rejected), "game");
    expect(attr(c.input, "value")).toBe(raw);
    expect(attr(c.input, "aria-invalid")).toBe("true");
    expect((attr(c.input, "aria-describedby") ?? "").split(/\s+/)).toContain("f-game-error");
    expect(c.all.some((n) => attr(n, "data-event-draft") !== undefined)).toBe(true);
    expect(text(c.all.find((n) => attr(n, "id") === "f-game-error"))).toBe(errors.game);
  });
}

it("U5-N04 Kit create/edit loads wait for admission rather than starting catalog reads in parallel", async () => {
  for (const surface of ["create", "edit"]) {
    const f = fixtureDb();
    const { env } = await fixtureEnv(f.db);
    kit.setEnv(env);
    let release;
    const waiting = new Promise((resolve) => {
      release = resolve;
    });
    const forbidden = Object.assign(new Error("fixture forbidden"), { status: 403 });
    const pending = kit.loads[surface]({
      parent: async () => {
        await waiting;
        throw forbidden;
      },
      params: { key: KEY },
      url: new URL(`/admin/events/${KEY}`, ORIGIN),
      setHeaders() {},
    });
    await Promise.resolve();
    expect(f.statements).toEqual([]);
    release();
    await expect(pending).rejects.toBe(forbidden);
    expect(f.statements).toEqual([]);
  }
});
