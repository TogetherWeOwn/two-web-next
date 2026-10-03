// route-inventory: GET /admin/join-attempts
// route-inventory: GET /admin/join-attempts/:id
// route-inventory: GET /join
// route-inventory: GET /join/discord
// route-inventory: GET /join/callback
// TOG-11764: JoinAttemptPolicy — join_attempts writes stay controller-direct.
//
// Parity §9: writes are denied; the join funnel controller writes direct.
// Parity §5: the admin viewer is read-only (done TOG-10826). This file pins
// the write path the read tests cannot: the admin surface exposes zero write
// routes for join_attempts, and every funnel row flows through the single
// controller insert (recordAttempt in src/join/service.ts, called only from
// src/join/route.ts). The deleters are the W13 retention prune (age-only,
// src/jobs/postgres.ts) and the TOG-12548 member-erasure operator command
// (subject-scoped `where discord_id`, src/member-erasure.ts). Test-only: the
// policy holds, so no product change ships here.
import { readFileSync, readdirSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import rawApp from "../src/index";
import { adminApp } from "../src/admin/routes";
import { joinAttempts, users } from "../src/db/schema";
import { createMemorySessionStore } from "../src/sessions";
import { UNSAFE_METHODS } from "../src/same-origin";
import { cookieFor, env, MODERATOR, SUBJECT } from "./helpers/member-data";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";

const root = new NodeURL("../", import.meta.url);
const read = (path: string) => readFileSync(new NodeURL(path, root), "utf8");

function srcFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(new NodeURL(dir, root), { withFileTypes: true })) {
      const rel = `${dir}${entry.name}`;
      if (entry.isDirectory()) walk(`${rel}/`);
      else if (entry.isFile() && (rel.endsWith(".ts") || rel.endsWith(".tsx"))) out.push(rel);
    }
  };
  walk("src/");
  return out.sort();
}

function filesMatching(re: RegExp): string[] {
  return srcFiles().filter((path) => re.test(read(path)));
}

describe("join-attempt write policy: admin surface exposes zero write routes", () => {
  it("mounted worker has no unsafe method on /admin/join-attempts*", () => {
    const writes = rawApp.routes.filter(
      (r) =>
        (UNSAFE_METHODS as readonly string[]).includes(r.method) &&
        (r.path === "/admin/join-attempts" || r.path.startsWith("/admin/join-attempts/")),
    );
    expect(writes).toEqual([]);
  });

  it("no unsafe registration anywhere mentions the join-attempts resource", () => {
    const touching = rawApp.routes.filter(
      (r) =>
        (UNSAFE_METHODS as readonly string[]).includes(r.method) &&
        r.path.toLowerCase().includes("join-attempt"),
    );
    expect(touching).toEqual([]);
  });

  it("admin sub-app registers exactly the two read-only join viewers", () => {
    const routes = adminApp(createMemorySessionStore())
      .routes.filter((r) => r.path.includes("join-attempts"))
      .map((r) => `${r.method} ${r.path}`)
      .sort();
    expect(routes).toEqual(["GET /join-attempts", "GET /join-attempts/:id"]);
  });

  it("mounted worker keeps both join viewers as moderator GETs", () => {
    for (const path of ["/admin/join-attempts", "/admin/join-attempts/:id"] as const) {
      expect(
        rawApp.routes.some((r) => r.method === "GET" && r.path === path),
        path,
      ).toBe(true);
    }
  });
});

describe("join-attempt write policy: single controller insert (DB-free source allowlist)", () => {
  it("exactly one INSERT INTO join_attempts, in the funnel service", () => {
    const writers = filesMatching(/INSERT INTO join_attempts/);
    expect(writers).toEqual(["src/join/service.ts"]);
    expect(read("src/join/service.ts").match(/INSERT INTO join_attempts/g)).toHaveLength(1);
  });

  it("exactly two deleters: the age-only retention prune and the subject-scoped member erasure", () => {
    const deleters = filesMatching(/delete from join_attempts/);
    expect(deleters).toEqual(["src/jobs/postgres.ts", "src/member-erasure.ts"]);
    // The erasure delete is subject-scoped (one member's rows), never age-based.
    expect(read("src/member-erasure.ts")).toMatch(/delete from join_attempts where discord_id = /);
  });

  it("no UPDATE of join_attempts anywhere in src/", () => {
    expect(filesMatching(/\bupdate\b[^;]*join_attempts/i)).toEqual([]);
  });

  it("recordAttempt is defined once and called only from the join callback route", () => {
    // recordAttempt\( matches the definition plus call sites; the import,
    // comments and docs carry no paren and stay out of this pin.
    expect(filesMatching(/recordAttempt\(/)).toEqual(["src/join/route.ts", "src/join/service.ts"]);
    expect(read("src/join/route.ts").match(/await recordAttempt\(/g)).toHaveLength(5);
    expect(read("src/join/route.ts")).not.toMatch(/INSERT INTO join_attempts/);
  });

  it("the joinAttempts table object is touched only by schema, read-only admin reads and retention wiring", () => {
    expect(filesMatching(/\bjoinAttempts\b/)).toEqual([
      "src/admin/reads.ts",
      "src/db/schema.ts",
      "src/jobs/cron.ts",
      "src/jobs/postgres.ts",
      "src/jobs/types.ts",
    ]);
  });

  it("the admin write store never touches join attempts", () => {
    const store = read("src/admin/store.ts");
    expect(store).not.toMatch(/join_attempts/);
    expect(store).not.toMatch(/\bjoinAttempts\b/);
    expect(store).not.toMatch(/recordAttempt/);
  });
});

describe.skipIf(!process.env.DATABASE_URL)("join-attempt write policy (agent-testdb)", () => {
  let fixture: MemberDataFixture;
  let sessions = createMemorySessionStore();
  let cookie = "";
  const bindings = () => ({ ...env, ADMIN_DB: fixture.db });
  const app = () => adminApp({ sessionStore: sessions, db: fixture.db });
  const rows = () => fixture.db.select().from(joinAttempts);

  beforeAll(async () => {
    fixture = await createMemberDataFixture(process.env.DATABASE_URL!);
  });
  beforeEach(async () => {
    await fixture.reset();
    sessions = createMemorySessionStore();
    cookie = await cookieFor(sessions, MODERATOR);
    // Keyed member reads fail closed on non-owner keys: seed the users row
    // and use a valid Discord-shaped owner id, like the sibling suites.
    await fixture.db.insert(users).values({
      id: SUBJECT.userId,
      username: SUBJECT.username,
      member: SUBJECT.member,
    });
    await fixture.db.insert(joinAttempts).values({
      outcome: "added",
      source: "site",
      requestId: "policy-req",
      discordId: SUBJECT.userId,
    });
  });
  afterAll(() => fixture?.dispose());

  it("admin list + detail reads leave the rows byte-identical", async () => {
    const before = await rows();
    expect(before).toHaveLength(1);
    expect(
      (await app().request("/join-attempts", { headers: { cookie } }, bindings())).status,
    ).toBe(200);
    expect(
      (await app().request(`/join-attempts/${before[0]!.id}`, { headers: { cookie } }, bindings()))
        .status,
    ).toBe(200);
    expect(await rows()).toEqual(before);
  });

  it("unsafe verbs on both admin viewers 404 and write nothing", async () => {
    const before = await rows();
    for (const path of ["/join-attempts", `/join-attempts/${before[0]!.id}`]) {
      for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const) {
        const res = await app().request(
          path,
          {
            method,
            headers: { cookie, origin: env.APP_URL, "content-type": "application/json" },
            body: "{}",
          },
          bindings(),
        );
        expect(res.status, `${method} ${path}`).toBe(404);
      }
    }
    expect(await rows()).toEqual(before);
  });
});
