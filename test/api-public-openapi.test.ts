// route-inventory: GET /openapi.json
// The served OpenAPI document matches the response schemas: every live
// public-API body validates against the spec's components, every spec path
// is a registered route, and the serializer field lists are the spec's
// required fields. Real app + agent-testdb/CI Postgres only.
import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import rawApp from "../src/index";
import app from "./app";
import { events, rsvps } from "../src/db/admin-schema";
import type { Env } from "../src/env";
import {
  COMMUNITY_SNAPSHOT_FIELDS,
  JOIN_HANDOFF_FIELDS,
  PUBLIC_API_EVENT_FIELDS,
} from "../src/public-data/contracts";
import { __resetApiPublicCacheForTests } from "../src/public-data/cache";
import { getOpenApiDocument } from "../src/public-data/openapi";
import type { EnvWithThrottle } from "../src/throttle";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";
import { validatePublicSchema } from "./helpers/public-api-schema";

const APP_URL = "https://next.example.test";

// All-digit 26-char key, same shape as the paging pins in test/events.test.ts.
const SPEC_KEY = "00000000000000000000000061";

const root = new URL("../", import.meta.url);
const inventory: { method: string; path: string }[] = JSON.parse(
  readFileSync(new URL("test/fixtures/route-inventory.json", root), "utf8"),
);

const SPEC_PATHS = [
  "/api/public/community",
  "/api/public/events",
  "/api/public/events/{key}",
  "/api/public/join",
];

describe.skipIf(!process.env.DATABASE_URL)("public read API: openapi.json", () => {
  let fixture: MemberDataFixture;
  let db: MemberDataFixture["db"];
  let env: Env & EnvWithThrottle;

  beforeAll(async () => {
    fixture = await createMemberDataFixture(process.env.DATABASE_URL!);
    db = fixture.db;
    env = {
      APP_URL,
      DATABASE_URL: process.env.DATABASE_URL!,
      DISCORD_INVITE_URL: "https://discord.gg/invite",
      THROTTLE_STORE: async () => null,
      get ADMIN_DB() {
        return db;
      },
    } as unknown as Env & EnvWithThrottle;
  });
  beforeEach(async () => {
    await fixture.reset();
    __resetApiPublicCacheForTests();
  });
  afterAll(async () => {
    await fixture?.dispose();
  });

  const get = async (path: string) =>
    app.request(path, { headers: { "cf-connecting-ip": "192.0.2.76" } }, env);

  type PathItem = { get?: { responses?: Record<string, unknown> } };

  it("serves the OpenAPI document as cacheable static JSON", async () => {
    const res = await get("/openapi.json");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("cache-control")).toBe("public, max-age=3600");
    const spec = (await res.json()) as ReturnType<typeof getOpenApiDocument>;
    expect(spec.openapi).toBe("3.1.0");
    const paths = spec.paths as unknown as Record<string, PathItem>;
    expect(Object.keys(paths).sort()).toEqual([...SPEC_PATHS].sort());
    for (const path of SPEC_PATHS) {
      expect(paths[path]?.get?.responses?.["200"]).toBeDefined();
      expect(paths[path]?.get?.responses?.["429"]).toBeDefined();
    }
    expect(paths["/api/public/events/{key}"]?.get?.responses?.["404"]).toBeDefined();
  });

  it("keeps 429 Retry-After on the response object, not the media type (OpenAPI 3.1)", () => {
    // Headers belong on the Response Object; the Media Type Object takes
    // only schema/examples/encoding. A Retry-After under the media type
    // fails OpenAPI 3.1 schema validation on every 429.
    const spec = getOpenApiDocument(APP_URL);
    const paths = spec.paths as unknown as Record<
      string,
      { get?: { responses?: Record<string, Record<string, unknown>> } }
    >;
    for (const path of SPEC_PATHS) {
      const r429 = paths[path]?.get?.responses?.["429"] as unknown as {
        headers?: Record<string, unknown>;
        content?: Record<string, Record<string, unknown>>;
      };
      expect(r429?.headers?.["Retry-After"], path).toEqual({
        schema: { type: "integer" },
      });
      const media = r429?.content?.["application/json"];
      expect((media?.["schema"] as { $ref?: string } | undefined)?.$ref, path).toBe(
        "#/components/schemas/PublicDataError",
      );
      expect("headers" in (media ?? {}), path).toBe(false);
    }
  });

  it("keeps the spec schemas identical to the serializer field lists", async () => {
    const spec = getOpenApiDocument(APP_URL);
    const schemas = spec.components.schemas as Record<string, { required?: string[] }>;
    expect(schemas.PublicApiEvent?.required?.slice().sort()).toEqual(
      [...PUBLIC_API_EVENT_FIELDS].sort(),
    );
    expect(schemas.CommunitySnapshot?.required?.slice().sort()).toEqual(
      [...COMMUNITY_SNAPSHOT_FIELDS].sort(),
    );
    expect(schemas.JoinHandoff?.required?.slice().sort()).toEqual([...JOIN_HANDOFF_FIELDS].sort());
  });

  it("validates every live public-API body against the served spec", async () => {
    const [ev] = await db
      .insert(events)
      .values({
        eventKey: SPEC_KEY,
        title: "Spec night",
        status: "published",
        startsAt: new Date("2099-11-04T20:00:00Z"),
        endsAt: new Date("2099-11-04T22:00:00Z"),
      })
      .returning();
    await db.insert(rsvps).values([{ eventId: ev!.id, userId: "going-1", status: "going" }]);
    const bodies: [string, string][] = [
      ["PublicApiEventCollection", "/api/public/events"],
      ["PublicApiEvent", `/api/public/events/${SPEC_KEY}`],
      ["CommunitySnapshot", "/api/public/community"],
      ["JoinHandoff", "/api/public/join"],
    ];
    for (const [schema, path] of bodies) {
      const res = await get(path);
      expect(res.status, path).toBe(200);
      expect(validatePublicSchema(await res.json(), schema)).toEqual([]);
    }
  });

  it("registers every spec path in the app and the route inventory", async () => {
    const routes = new Set(
      rawApp.routes.map(
        (route: { method: string; path: string }) => `${route.method} ${route.path}`,
      ),
    );
    const names = new Set(inventory.map((route) => `${route.method} ${route.path}`));
    const honoPath = (path: string) => path.replace("{key}", ":key");
    for (const path of SPEC_PATHS) {
      expect(routes.has(`GET ${honoPath(path)}`), path).toBe(true);
      expect(names.has(`GET ${honoPath(path)}`), path).toBe(true);
    }
    expect(routes.has("GET /openapi.json")).toBe(true);
    expect(names.has("GET /openapi.json")).toBe(true);
  });
});

// Paging is an agent-facing contract, so these consistency checks must run
// without a database. The served OpenAPI text is the paging source of truth.
describe("public read API: OpenAPI paging consistency (offline)", () => {
  const operation = () => getOpenApiDocument(APP_URL).paths["/api/public/events"].get;
  const parameter = (name: string) => {
    const found = operation().parameters.find((p) => p.name === name);
    expect(found, `Missing paging parameter ${name}`).toBeDefined();
    return found!;
  };

  it("advertises both per_page and its limit alias with the same bounds and precedence", () => {
    const primary = parameter("per_page");
    const alias = parameter("limit");
    expect(primary.in).toBe("query");
    expect(alias.in).toBe("query");
    expect(primary.schema).toMatchObject({ type: "integer", minimum: 1, maximum: 20, default: 20 });
    expect(alias.schema).toEqual(primary.schema);
    expect(alias.description).toMatch(/alias/i);
    expect(alias.description).toContain("per_page");
    const wording = `${primary.description} ${alias.description}`;
    expect(wording).toMatch(/preced|priority|takes\s+prefer|wins|overrid/i);
  });

  it("documents a finite raw-page ceiling", () => {
    const page = parameter("page");
    const schema = page.schema as { maximum?: number };
    expect(page.schema).toMatchObject({ type: "integer", minimum: 1, default: 1 });
    expect(Number.isSafeInteger(schema.maximum)).toBe(true);
    expect(schema.maximum).toBeGreaterThan(1);
    expect(page.description).toMatch(/cap|maximum|ceiling/i);
  });

  it("explains invalid defaults, range coercion, and clamp-to-last-page instead of 422", () => {
    for (const name of ["page", "per_page", "limit"]) {
      const text = parameter(name).description;
      expect(text, name).toMatch(/invalid|malformed|non.?integer/i);
      expect(text, name).toMatch(/default|fall.?back/i);
      expect(text, name).toMatch(/clamp|coerc/i);
    }
    expect(parameter("page").description).toMatch(/last\s+page/i);
    expect(operation().responses).not.toHaveProperty("422");
  });
});
