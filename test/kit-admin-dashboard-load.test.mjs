// Kit admin dashboard load wiring: the outage-to-503 decision in
// web/src/routes/admin/+page.server.ts is behavioural, not source text.
// resolveDashboardWidgets is unit-tested; this drives the real load with a
// fake Db so an inverted `if (!widgets.outage)` fails here instead of
// shipping a 500/503 swap silently.
//
// MJS, not TS: the root `tsc --noEmit` (include src/tail/test/tier0,
// allowJs off) would otherwise follow the static web import into
// SvelteKit-only types (./$types, Cloudflare.Env) and fail. Vitest runs
// both .test.ts and .test.mjs, so the wiring stays executed without
// weakening the type gate — the same reason
// test/hook-route-ownership.test.mjs mocks cloudflare:workers here.
import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ env: {} }));

vi.mock("../src/admin/db", async (importOriginal) => {
  const orig = await importOriginal();
  return { ...orig, dbFor: vi.fn() };
});

import { dbFor } from "../src/admin/db";
import { load } from "../web/src/routes/admin/+page.server.js";

const actor = { id: "100000000000000111", username: "mod" };
const parent = async () => ({ actor });

const refused = () =>
  Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), { code: "ECONNREFUSED" });

describe("Kit admin dashboard load: outage wiring", () => {
  it("a refused database makes the load throw 503, never page data", async () => {
    const fakeDb = {
      transaction: async () => {
        throw refused();
      },
    };
    vi.mocked(dbFor).mockResolvedValueOnce(fakeDb);
    const err = await load({ parent }, {}).catch((e) => e);
    expect(err?.status).toBe(503);
  });

  it("an ordinary widget failure resolves with omitted sections, never 503", async () => {
    const fakeDb = {
      transaction: async () => {
        throw new Error("syntax error at end of input");
      },
    };
    vi.mocked(dbFor).mockResolvedValueOnce(fakeDb);
    const data = await load({ parent }, {});
    expect(data.funnel).toBeUndefined();
    expect(data.zeroSearches).toBeUndefined();
  });
});
