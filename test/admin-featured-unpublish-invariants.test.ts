// Independent regression pins: real committed writes, isolate-local cache,
// complete persisted rows, and real Hono/Kit list rendering.
// route-inventory: POST /admin/featured/:id/unpublish
import { parse, type DefaultTreeAdapterMap } from "parse5";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { adminApp } from "../src/admin/routes";
import { activityLog, featuredContents } from "../src/db/admin-schema";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";
import { __resetHomeGuestCacheForTests, cachedFeatured } from "../src/home-cache";
import { createMemorySessionStore, type SessionStore } from "../src/sessions";
import {
  compileInventoryKit,
  inventoryRow,
  renderInventory,
} from "./helpers/admin-inventory-recovery";
import { cookieFor, env, MODERATOR } from "./helpers/member-data";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";

const NOW = new Date("2035-06-15T12:00:00Z");
const storedSlot = {
  legacyId: "987654321",
  title: "Withdraw this stale slot",
  body: "Keep the complete stored body unchanged.",
  url: "https://example.test/old-slot",
  imageUrl: "https://retired-images.example.net/old-slot.png",
  imageAlt: "Original alternative text",
  isPublished: true,
  position: 17,
  startsAt: new Date("2001-01-02T03:04:05Z"),
  endsAt: new Date("2099-12-30T23:59:00Z"),
  createdBy: "100000000000000104",
  createdAt: new Date("2018-02-03T04:05:06Z"),
  updatedAt: new Date("2019-03-04T05:06:07Z"),
} satisfies typeof featuredContents.$inferInsert;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("featured unpublish: persisted and cached invariants", () => {
  let fixture: MemberDataFixture;
  let db: Db;
  let sessions: SessionStore;
  let cookie: string;
  let opens: number;
  type Gate = {
    entered: ReturnType<typeof deferred<void>>;
    release: ReturnType<typeof deferred<boolean>>;
  };
  let nextTransaction: Gate | undefined;
  const bindings = () => ({ ...env, ADMIN_DB: db }) as Env;
  const readFeatured = () =>
    cachedFeatured(
      bindings(),
      async () => {
        opens++;
        return db;
      },
      NOW,
    );
  const unpublish = async (id: number) =>
    adminApp({ sessionStore: sessions, db }).request(
      `/featured/${id}/unpublish`,
      {
        method: "POST",
        headers: {
          cookie,
          origin: env.APP_URL,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: "",
      },
      bindings(),
    );
  const rows = () => fixture.db.select().from(featuredContents).orderBy(featuredContents.id);
  const audits = () => fixture.db.select().from(activityLog).orderBy(activityLog.id);
  const seed = async (overrides: Partial<typeof featuredContents.$inferInsert> = {}) => {
    const [row] = await fixture.db
      .insert(featuredContents)
      .values({ ...storedSlot, ...overrides })
      .returning();
    return row!;
  };
  const holdNextTransaction = () => {
    const gate = { entered: deferred<void>(), release: deferred<boolean>() };
    nextTransaction = gate;
    return gate;
  };

  beforeAll(async () => {
    // This suite deliberately requires an approved disposable database rather
    // than silently skipping the commit/rollback proofs when none is supplied.
    fixture = await createMemberDataFixture(process.env.DATABASE_URL!);
  });
  beforeEach(async () => {
    await fixture.reset();
    await fixture.db.delete(featuredContents);
    __resetHomeGuestCacheForTests();
    opens = 0;
    nextTransaction = undefined;
    sessions = createMemorySessionStore();
    cookie = await cookieFor(sessions, MODERATOR);
    // Gate the real session adapter: dbFor clones the Drizzle facade for
    // read observation, so replacing only db.transaction would be bypassed.
    // The callback still executes against Postgres and COMMIT/ROLLBACK stays real.
    db = fixture.db;
    const session = (db as unknown as { session: { transaction: Db["transaction"] } }).session;
    const transaction = session.transaction.bind(session);
    vi.spyOn(session, "transaction").mockImplementation((work, config) => {
      const gate = nextTransaction;
      nextTransaction = undefined;
      return transaction(async (tx) => {
        const result = await work(tx);
        if (gate) {
          gate.entered.resolve();
          if (!(await gate.release.promise)) throw new Error("Acceptance transaction rollback");
        }
        return result;
      }, config);
    });
  });
  afterEach(() => {
    __resetHomeGuestCacheForTests();
    vi.restoreAllMocks();
  });
  afterAll(() => fixture?.dispose());

  it("changes only isPublished in the full stored row, including provenance and timestamps", async () => {
    const before = await seed();
    const first = await unpublish(before.id);
    expect(first.status).toBe(303);
    expect(first.headers.get("location")).toBe("/admin/featured");
    expect(await rows()).toEqual([{ ...before, isPublished: false }]);
    const firstAudits = await audits();
    expect(firstAudits).toHaveLength(1);
    expect(firstAudits[0]!.properties).toEqual({ isPublished: { before: true, after: false } });

    const second = await unpublish(before.id);
    expect(second.status).toBe(303);
    expect(second.headers.get("location")).toBe("/admin/featured");
    expect(await rows()).toEqual([{ ...before, isPublished: false }]);
    expect(await audits()).toEqual(firstAudits);
  });

  it("keeps the warm guest entry until commit, then retires it before returning success", async () => {
    const removed = await seed();
    const survivor = await seed({ legacyId: null, title: "Still published", position: 18 });
    expect((await readFeatured()).map((row) => row.id)).toEqual([removed.id, survivor.id]);
    expect((await readFeatured()).map((row) => row.id)).toEqual([removed.id, survivor.id]);
    expect(opens).toBe(1); // The premise is a real cache hit, not a direct SQL read.

    const gate = holdNextTransaction();
    const pending = unpublish(removed.id);
    try {
      await Promise.race([
        gate.entered.promise,
        pending.then(() => {
          throw new Error("Write returned before the commit gate");
        }),
      ]);
      expect((await readFeatured()).map((row) => row.id)).toEqual([removed.id, survivor.id]);
      expect(opens).toBe(1); // Moving retirement inside the transaction breaks this.
    } finally {
      gate.release.resolve(true);
      await pending;
    }
    expect((await pending).status).toBe(303);
    expect((await readFeatured()).map((row) => row.id)).toEqual([survivor.id]);
    expect(opens).toBe(2); // Deleting retirement serves the withdrawn cached slot.
  });

  it("a rolled-back write preserves the stored row, audit log and warm guest entry", async () => {
    const before = await seed();
    expect((await readFeatured()).map((row) => row.id)).toEqual([before.id]);
    expect(opens).toBe(1);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const gate = holdNextTransaction();
    const pending = unpublish(before.id);
    try {
      await Promise.race([
        gate.entered.promise,
        pending.then(() => {
          throw new Error("Write returned before the rollback gate");
        }),
      ]);
    } finally {
      gate.release.resolve(false);
      await pending;
    }
    expect((await pending).status).toBe(500);
    expect(await rows()).toEqual([before]);
    expect(await audits()).toEqual([]);
    expect((await readFeatured()).map((row) => row.id)).toEqual([before.id]);
    expect(opens).toBe(1);
  });

  it("an already-unpublished no-op preserves a nonempty warm guest entry without another read", async () => {
    const withdrawn = await seed({ isPublished: false });
    const survivor = await seed({ legacyId: null, title: "Still published" });
    expect((await readFeatured()).map((row) => row.id)).toEqual([survivor.id]);
    expect(opens).toBe(1);
    expect((await unpublish(withdrawn.id)).status).toBe(303);
    expect((await readFeatured()).map((row) => row.id)).toEqual([survivor.id]);
    expect(opens).toBe(1);
    expect(await rows()).toEqual([withdrawn, survivor]);
    expect(await audits()).toEqual([]);
  });
});

type HtmlNode = DefaultTreeAdapterMap["node"];
type HtmlElement = DefaultTreeAdapterMap["element"];
function elements(node: HtmlNode, name: string): HtmlElement[] {
  return [
    ...("tagName" in node && node.tagName === name ? [node] : []),
    ...("childNodes" in node ? node.childNodes.flatMap((child) => elements(child, name)) : []),
  ];
}
const attribute = (node: HtmlElement, name: string) =>
  node.attrs.find((attr) => attr.name === name)?.value;

// Removing scheduled/expired actions, adding a draft action, or retaining only
// source markup with no actual SSR form must fail for BOTH list renderers.
describe("featured list unpublish actions in real Hono and Kit SSR", () => {
  beforeAll(async () => {
    await compileInventoryKit();
  });
  it.each(["Hono", "Kit"] as const)(
    "%s renders actions for live, scheduled and expired published rows only",
    async (renderer) => {
      const rows = [
        { ...inventoryRow("featured", 71), title: "Live slot" },
        {
          ...inventoryRow("featured", 72),
          title: "Scheduled slot",
          startsAt: new Date("2099-12-01T00:00:00Z"),
        },
        {
          ...inventoryRow("featured", 73),
          title: "Expired slot",
          endsAt: new Date("2001-01-01T00:00:00Z"),
        },
        { ...inventoryRow("featured", 74), title: "Unpublished slot", isPublished: false },
      ];
      const result = await renderInventory(renderer, "featured", "", rows);
      expect(result.status).toBe(200);
      const document = parse(result.html);
      const actions = elements(document, "form").filter((form) =>
        attribute(form, "action")?.endsWith("/unpublish"),
      );
      expect(actions.map((form) => attribute(form, "action")).sort()).toEqual([
        "/admin/featured/71/unpublish",
        "/admin/featured/72/unpublish",
        "/admin/featured/73/unpublish",
      ]);
      for (const form of actions) {
        expect(attribute(form, "method")?.toLowerCase()).toBe("post");
        const buttons = elements(form, "button");
        expect(buttons).toHaveLength(1);
        expect(attribute(buttons[0]!, "type")).toBe("submit");
        expect(buttons[0]!.childNodes).toContainEqual(
          expect.objectContaining({ nodeName: "#text", value: "Unpublish" }),
        );
      }
      expect(result.html).toContain("Unpublished slot");
    },
  );
});
