import { beforeEach, describe, expect, it, vi } from "vitest";
import { adminApp } from "../src/admin/routes";
import { parseRecordId } from "../src/admin/record-id";
import {
  deleteFeatured,
  getFeatured,
  NotFoundError,
  recordAccess,
  updateFeatured,
  type FeaturedRow,
} from "../src/admin/store";
import type { Db } from "../src/db/index";
import { createMemorySessionStore, type Sql } from "../src/sessions";
import type { EnvWithAdminDb } from "../src/admin/db";
import type { EnvWithThrottle } from "../src/throttle";
import { cookieFor, env, MEMBER, MODERATOR } from "./helpers/member-data";
import { withThrottleTx } from "./helpers/throttle-tx-double";

vi.mock("../src/admin/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/admin/store")>()),
  getFeatured: vi.fn(),
  updateFeatured: vi.fn(),
  deleteFeatured: vi.fn(),
  recordAccess: vi.fn(),
}));

const invalidIds = [
  "0x1",
  "0X1",
  "0b1",
  "0o1",
  "1e0",
  "1E0",
  "1.0",
  "1.",
  "+1",
  "01",
  "0001",
  " 1",
  "1 ",
  "\t1",
  "1\n",
  "1\r\n",
  " 1",
  "",
  "0",
  "-1",
  "-2147483648",
  "2147483648",
  "4294967295",
  "9007199254740991",
  "9007199254740992",
  "9007199254740993",
  "9999999999999999999999999999999999999999",
  "Infinity",
  "NaN",
  "abc",
  "１",
];
const validIds = [1, 42, 2_147_483_646, 2_147_483_647];
const routes = [
  { method: "GET", suffix: "" },
  { method: "POST", suffix: "" },
  { method: "POST", suffix: "/delete" },
];
const dbOperation = vi.fn(() => {
  throw new Error("fixture must not select, mutate or write activity to a DB");
});
const db = {
  select: dbOperation,
  insert: dbOperation,
  update: dbOperation,
  delete: dbOperation,
  transaction: dbOperation,
  execute: dbOperation,
} as unknown as Db;
const bindings: EnvWithAdminDb = { ...env, ADMIN_DB: db };
const actor = { id: MODERATOR.userId, username: MODERATOR.username };
const row: FeaturedRow = {
  id: 1,
  legacyId: null,
  title: "Featured fixture",
  body: null,
  url: null,
  imageUrl: null,
  imageAlt: null,
  isPublished: false,
  position: 0,
  startsAt: null,
  endsAt: null,
  createdBy: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getFeatured).mockImplementation(async (_, id) => ({
    ...row,
    id,
    startsAtText: null,
    endsAtText: null,
  }));
  vi.mocked(updateFeatured).mockImplementation(async (_, __, id) => ({ ...row, id }));
  vi.mocked(deleteFeatured).mockResolvedValue(undefined);
  vi.mocked(recordAccess).mockResolvedValue(true);
});

function expectNoRecordAccess() {
  expect(getFeatured).not.toHaveBeenCalled();
  expect(updateFeatured).not.toHaveBeenCalled();
  expect(deleteFeatured).not.toHaveBeenCalled();
  expect(recordAccess).not.toHaveBeenCalled();
  expect(dbOperation).not.toHaveBeenCalled();
}

async function request(
  id: string,
  route: (typeof routes)[number],
  options: {
    actor?: typeof MEMBER | null;
    bindings?: EnvWithAdminDb & EnvWithThrottle;
  } = {},
) {
  const sessions = createMemorySessionStore();
  const identity = options.actor === undefined ? MODERATOR : options.actor;
  const cookie = identity ? await cookieFor(sessions, identity) : "";
  return adminApp({ sessionStore: sessions, db }).request(
    `/featured/${encodeURIComponent(id)}${route.suffix}`,
    {
      method: route.method,
      headers: { cookie, origin: env.APP_URL },
      ...(route.method === "POST"
        ? { body: new URLSearchParams({ title: "Updated fixture", position: "0" }) }
        : {}),
    },
    options.bindings ?? bindings,
  );
}

describe("canonical PostgreSQL serial record ID", () => {
  it.each(invalidIds)("rejects %j", (raw) => {
    expect(parseRecordId(raw)).toBeNull();
  });

  it.each(validIds)("admits %i exactly", (id) => {
    expect(parseRecordId(String(id))).toBe(id);
  });
});

for (const route of routes) {
  describe(`${route.method} featured/:id${route.suffix} (synthetic stores)`, () => {
    // An empty path is the collection route, not a malformed record ID.
    it.each(invalidIds.filter((id) => id !== ""))(
      "404s %j before any record lookup or activity write",
      async (id) => {
        const res = await request(id, route);
        expect(res.status).toBe(404);
        expect(res.headers.get("content-type")).toContain("text/html");
        expect(res.headers.get("cache-control")).toBe("private, no-store");
        const html = await res.text();
        expect(html).toContain("Featured content not found");
        expect(html).toContain("<html");
        expectNoRecordAccess();
      },
    );

    it("rejects an invalid ID even when the record DB is unconfigured", async () => {
      expect((await request("0x1", route, { bindings: env })).status).toBe(404);
      expectNoRecordAccess();
    });

    it.each(validIds)("preserves the handler behavior for canonical ID %i", async (id) => {
      const res = await request(String(id), route);
      if (route.method === "GET") {
        expect(res.status).toBe(200);
        expect(await res.text()).toContain(`action="/admin/featured/${id}"`);
        expect(getFeatured).toHaveBeenCalledExactlyOnceWith(expect.anything(), id);
        expect(updateFeatured).not.toHaveBeenCalled();
        expect(deleteFeatured).not.toHaveBeenCalled();
      } else if (route.suffix === "/delete") {
        expect(res.status).toBe(303);
        expect(res.headers.get("location")).toBe("/admin/featured");
        expect(deleteFeatured).toHaveBeenCalledExactlyOnceWith(expect.anything(), actor, id);
        expect(getFeatured).not.toHaveBeenCalled();
        expect(updateFeatured).not.toHaveBeenCalled();
      } else {
        expect(res.status).toBe(303);
        expect(res.headers.get("location")).toBe(`/admin/featured/${id}`);
        expect(getFeatured).toHaveBeenCalledExactlyOnceWith(expect.anything(), id);
        expect(updateFeatured).toHaveBeenCalledExactlyOnceWith(
          expect.anything(),
          actor,
          id,
          expect.objectContaining({ title: "Updated fixture" }),
        );
        expect(deleteFeatured).not.toHaveBeenCalled();
      }
      expect(dbOperation).not.toHaveBeenCalled();
    });

    it("preserves the branded 404 for an absent canonical ID", async () => {
      vi.mocked(getFeatured).mockResolvedValue(null);
      vi.mocked(deleteFeatured).mockRejectedValue(new NotFoundError("featured content"));
      const res = await request("42", route);
      expect(res.status).toBe(404);
      expect(await res.text()).toContain("Featured content not found");
      expect(updateFeatured).not.toHaveBeenCalled();
      expect(recordAccess).not.toHaveBeenCalled();
      expect(dbOperation).not.toHaveBeenCalled();
    });

    it.each(["1", "0x1"])(
      "keeps the guest and member gates ahead of ID admission for %s",
      async (id) => {
        const guest = await request(id, route, { actor: null });
        expect([302, 303]).toContain(guest.status);
        expect(guest.headers.get("location")).toMatch(/^\/auth\//);
        expect((await request(id, route, { actor: MEMBER })).status).toBe(403);
        expectNoRecordAccess();
      },
    );

    if (route.method === "POST") {
      it.each(["1", "0x1"])("keeps the write throttle ahead of ID admission for %s", async (id) => {
        const sql = vi.fn().mockResolvedValue([{ n: 30, wait: 17 }]);
        const res = await request(id, route, {
          bindings: {
            ...bindings,
            THROTTLE_STORE: async () => withThrottleTx(sql as unknown as Sql),
          },
        });
        expect(res.status).toBe(429);
        expect(res.headers.get("retry-after")).toBe("17");
        expect(sql).toHaveBeenCalledTimes(1);
        expect(sql.mock.calls[0]![1]).toBe("admin-write:anon");
        expectNoRecordAccess();
      });
    }
  });
}
