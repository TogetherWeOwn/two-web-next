// route-inventory: GET /api/public/events
// route-inventory: GET /api/public/events/:key
// route-inventory: GET /api/public/community
// route-inventory: GET /api/public/join
// route-inventory: GET /openapi.json
// route-inventory: POST /api/agent-events
// route-inventory: GET /events.ics
// route-inventory: GET /events/:file{.+\.ics}
// Acceptance (failing-first, Test Author owned): public API contracts —
// unknown /api/public paths return JSON, conditional reads are documented
// (H2: R-A1 + R-A2). At source pin 0f8fdd17f21abe7d0f7c015001b9415b180efe99,
// src/error-registration.ts:7-19 falls through to branded HTML while
// docs/machine-errors.md:9-18 promises the REST error envelope, and
// src/public-data/routes.ts:269-309,317-334 serves ETag/304 while
// src/public-data/openapi.ts:190-246 omits validator/header/304 contracts.
// These tests pin the fix: exact-namespace JSON 404s (GET/HEAD, with and
// without ASSETS, no reflection, no asset lookup), boundary preservation
// (/api/publicity, ICS, agent ingress, known routes), shared OpenAPI
// conditional definitions with admission/freshness/retirement docs, and the
// offline machine-contract check. Real app + agent-testdb/CI Postgres for
// the DB slice; the offline slices need no database. No mutating public
// probes. The builder incorporates this branch and never edits this file;
// corrections return to the Test Author.
import { readFileSync, readdirSync } from "node:fs";
import { URL } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import app from "./app";
import { events } from "../src/db/admin-schema";
import type { Env } from "../src/env";
import { PUBLIC_EVENT_READS_PER_MINUTE } from "../src/events/routes-shared";
import {
  API_PUBLIC_BOUNDS,
  PUBLIC_DATA_ERROR_CODES,
  PUBLIC_DATA_ERROR_NEXT,
} from "../src/public-data/contracts";
import { API_PUBLIC_CACHE_TTL_MS, __resetApiPublicCacheForTests } from "../src/public-data/cache";
import { getOpenApiDocument } from "../src/public-data/openapi";
import type { Sql } from "../src/sessions";
import type { EnvWithThrottle } from "../src/throttle";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";
import { validatePublicSchema } from "./helpers/public-api-schema";

const APP_URL = "https://next.example.test";
const INVITE_URL = "https://discord.gg/test-invite-handoff";
const ASSET_CANARY = "ASSET-BYTES-SHOULD-NOT-LEAK";

// All-digit 26-char keys, same shape as the api-public-events pins, so no
// secret scanner trips and every key parses as a public event id.
const key = (n: number) => String(n).padStart(26, "0");

const UNKNOWN_PATHS = [
  "/api/public",
  "/api/public/",
  "/api/public/cache",
  "/api/public/invalidate",
  "/api/public/unknown",
  "/api/public/unknown/nested/deep",
  "/api/public/events/",
  `/api/public/events/${key(1)}/extra`,
  "/api/public/community/extra",
  "/api/public/join/extra",
  "/api/public/unknown?probe=1",
] as const;

// Every entry must stay an unknown path inside /api/public after WHATWG URL
// normalization: bare `%2e%2e` segments resolve away before the app sees
// them, and known routes keep their own status (see the controls below).
const HOSTILE_PATHS = [
  "/api/public/%2e%2e%2f%2e%2e%2fetc/passwd",
  "/api/public/..%2f..%2fetc/passwd",
  "/api/public/%3Cscript%3Ealert(1)%3C/script%3E",
  "/api/public/unknown?probe=%3Cscript%3E",
  "/api/public/unknown/%00",
  "/api/public/unknown?x=../etc/passwd",
] as const;

const BOUNDARY_PATHS = [
  "/api/publicity",
  "/api/publicity/",
  "/api/publicity/foo",
  "/api/public-ev",
  "/api/public2",
] as const;

const SPEC_PATHS = [
  "/api/public/community",
  "/api/public/events",
  "/api/public/events/{key}",
  "/api/public/join",
] as const;

const baseEnv = {
  APP_URL,
  DISCORD_INVITE_URL: INVITE_URL,
  DISCORD_BOT_TOKEN: "bot-token-canary-never-served",
  THROTTLE_STORE: async () => null,
} as unknown as Env & EnvWithThrottle;

const assetEnv = (body: BodyInit | null, init: ResponseInit, fetch: ReturnType<typeof vi.fn>) =>
  ({
    ...baseEnv,
    ASSETS: { fetch },
  }) as unknown as Env & EnvWithThrottle;

const maxAgeOf = (res: Response): number | null => {
  const header = res.headers.get("cache-control");
  const match = header ? header.match(/max-age=(\d+)/) : null;
  return match ? Number(match[1]) : null;
};

const junkEtag = (etag: string) => {
  const flipped = etag.replace(
    /^(W\/)?"(.)/,
    (_m, weak: string | undefined, ch: string) => `${weak ?? ""}"${ch === "0" ? "1" : "0"}`,
  );
  return flipped !== etag ? flipped : '"junk-not-the-current-validator"';
};

const strongForm = (etag: string) => etag.replace(/^W\//, "");
const weakForm = (etag: string) => `W/${strongForm(etag)}`;

type PublicErrorBody = {
  error: { code: string; message: string; request_id: string; next: string };
};

async function expectUnknownJson(res: Response, path: string): Promise<PublicErrorBody> {
  expect(res.status, path).toBe(404);
  expect(res.headers.get("content-type"), path).toContain("application/json");
  expect(res.headers.get("cache-control"), path).toBe("no-store, private");
  expect(res.headers.get("set-cookie"), path).toBeNull();
  const headerId = res.headers.get("x-request-id");
  expect(headerId, `${path} x-request-id`).toBeTruthy();
  const raw = await res.text();
  expect(raw, `${path} no branded HTML`).not.toMatch(/<!doctype|<html|error-heading/i);
  expect(raw, `${path} no asset bytes`).not.toContain(ASSET_CANARY);
  expect(raw, `${path} no reflected path`).not.toContain(encodeURIComponent(path));
  // The raw path must never echo: hostile bytes stay inert.
  for (const fragment of ["<script", "etc/passwd", "%2e", "%00", "%3C"]) {
    if (path.toLowerCase().includes(fragment.toLowerCase())) {
      expect(raw.toLowerCase(), `${path} inert ${fragment}`).not.toContain(fragment.toLowerCase());
    }
  }
  const body = JSON.parse(raw) as PublicErrorBody;
  expect(validatePublicSchema(body, "PublicDataError"), path).toEqual([]);
  expect(body.error.code, path).toBe("not_found");
  expect(body.error.next, path).toBe(PUBLIC_DATA_ERROR_NEXT.not_found);
  expect(typeof body.error.message, path).toBe("string");
  expect(body.error.message.length, path).toBeGreaterThan(0);
  expect(body.error.request_id, path).toBe(headerId);
  return body;
}

// ---------------------------------------------------------------------------
// Offline: unknown paths return JSON, boundaries stay put. No DB needed.
// ---------------------------------------------------------------------------

describe("public API unknown paths return JSON (offline)", () => {
  beforeEach(() => {
    __resetApiPublicCacheForTests();
  });

  const get = (path: string, env: Env & EnvWithThrottle = baseEnv, ip = "192.0.2.91") =>
    app.request(path, { headers: { "cf-connecting-ip": ip } }, env);

  it.each([...UNKNOWN_PATHS])("GET %s answers the JSON not_found envelope", async (path) => {
    const body = await expectUnknownJson(await get(path), path);
    expect(body.error.code).toBe("not_found");
  });

  it.each([...UNKNOWN_PATHS])("GET %s ignores ASSETS and never looks an asset up", async (path) => {
    const fetch = vi.fn(async () => new Response(ASSET_CANARY, { status: 200 }));
    const res = await get(path, assetEnv(ASSET_CANARY, { status: 200 }, fetch));
    await expectUnknownJson(res, path);
    expect(fetch, path).not.toHaveBeenCalled();
  });

  it.each([...HOSTILE_PATHS])("GET %s stays an inert JSON 404", async (path) => {
    const res = await get(path);
    expect(res.status, path).not.toBe(500);
    await expectUnknownJson(res, path);
  });

  it.each([...HOSTILE_PATHS])("GET %s with ASSETS stays inert with no lookup", async (path) => {
    const fetch = vi.fn(async () => new Response(ASSET_CANARY, { status: 200 }));
    const res = await get(path, assetEnv(ASSET_CANARY, { status: 200 }, fetch));
    await expectUnknownJson(res, path);
    expect(fetch, path).not.toHaveBeenCalled();
  });

  it.each([...HOSTILE_PATHS])("%s stays an unknown in-namespace path once normalized", (path) => {
    // Guard on the fixture itself: a hostile entry that normalizes out of
    // the namespace or onto a known route cannot test the unknown handler.
    const { pathname } = new URL(path, APP_URL);
    expect(pathname, path).toMatch(/^\/api\/public\/./);
    expect(["/api/public/community", "/api/public/events", "/api/public/join"], path).not.toContain(
      pathname,
    );
    expect(pathname, path).not.toMatch(/^\/api\/public\/events\/[^/]+$/);
  });

  it("keeps the unknown message and next static across paths", async () => {
    const first = await expectUnknownJson(await get("/api/public/cache"), "/api/public/cache");
    const second = await expectUnknownJson(
      await get("/api/public/unknown/nested/deep"),
      "/api/public/unknown/nested/deep",
    );
    expect(second.error.message).toBe(first.error.message);
    expect(second.error.next).toBe(first.error.next);
  });

  it.each([...UNKNOWN_PATHS])("HEAD %s keeps status/headers with no body", async (path) => {
    const res = await app.request(
      path,
      { method: "HEAD", headers: { "cf-connecting-ip": "192.0.2.92" } },
      baseEnv,
    );
    expect(res.status, path).toBe(404);
    expect(res.headers.get("content-type"), path).toContain("application/json");
    expect(res.headers.get("cache-control"), path).toBe("no-store, private");
    expect(res.headers.get("x-request-id"), path).toBeTruthy();
    expect(res.headers.get("set-cookie"), path).toBeNull();
    expect(await res.text(), path).toBe("");
  });

  it.each([...UNKNOWN_PATHS])(
    "HEAD %s with ASSETS keeps headers, no body, no lookup",
    async (path) => {
      const fetch = vi.fn(async () => new Response(ASSET_CANARY, { status: 200 }));
      const res = await app.request(
        path,
        { method: "HEAD", headers: { "cf-connecting-ip": "192.0.2.93" } },
        assetEnv(ASSET_CANARY, { status: 200 }, fetch),
      );
      expect(res.status, path).toBe(404);
      expect(res.headers.get("content-type"), path).toContain("application/json");
      expect(await res.text(), path).toBe("");
      expect(fetch, path).not.toHaveBeenCalled();
    },
  );

  it.each([...BOUNDARY_PATHS])("GET %s stays outside the JSON namespace", async (path) => {
    // Control: the exact /api/public namespace only. A prefix match without
    // the boundary would wrongly JSON-encode these.
    const res = await get(path);
    expect(res.status, path).toBe(404);
    expect(res.headers.get("content-type"), path).toContain("text/html");
    const raw = await res.text();
    expect(raw, path).toMatch(/We cannot find that page|error-heading/);
    expect(() => JSON.parse(raw), path).toThrow();
  });

  it("serves /api/publicity from ASSETS when an asset exists there", async () => {
    // Control: ASSETS still serves outside the exact namespace.
    const fetch = vi.fn(async () => new Response(ASSET_CANARY, { status: 200 }));
    const res = await get("/api/publicity", assetEnv(ASSET_CANARY, { status: 200 }, fetch));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(ASSET_CANARY);
    expect(fetch).toHaveBeenCalled();
  });

  it("falls through to HTML when ASSETS 404s outside the namespace", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 404 }));
    const res = await get("/api/publicity", assetEnv(null, { status: 404 }, fetch));
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(fetch).toHaveBeenCalled();
  });

  it("keeps the malformed event key 422, not the unknown 404", async () => {
    // Control: /api/public/events/:key still parses before the unknown handler.
    const res = await get("/api/public/events/not-a-key!!!");
    expect(res.status).toBe(422);
    const body = (await res.json()) as PublicErrorBody;
    expect(body.error.code).toBe("invalid_request");
    expect(validatePublicSchema(body, "PublicDataError")).toEqual([]);
  });

  it("keeps a NUL event key 422 inert, not the unknown 404", async () => {
    // Control: a hostile byte in the key is still a malformed known route.
    const res = await get("/api/public/events/%00");
    expect(res.status).toBe(422);
    const raw = await res.text();
    expect(raw).not.toContain("%00");
    const body = JSON.parse(raw) as PublicErrorBody;
    expect(body.error.code).toBe("invalid_request");
    expect(validatePublicSchema(body, "PublicDataError")).toEqual([]);
  });

  it("keeps a known route 200 under a hostile query, without reflection", async () => {
    // Control: the query is not a path, so the known route still answers.
    const res = await get("/api/public/community?x=../etc/passwd");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.text()).not.toContain("etc/passwd");
  });

  it("keeps the disabled agent ingress envelope, not the public 404", async () => {
    // Control: POST /api/agent-events is a different surface with its own
    // code/reason/message/request_id/next vocabulary.
    const res = await app.request(
      "/api/agent-events",
      {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": "192.0.2.94" },
        body: JSON.stringify({ op: "read" }),
      },
      baseEnv,
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ code: "ingress_disabled", reason: "ingress_disabled" });
    expect(body).toHaveProperty("request_id", res.headers.get("x-request-id"));
    expect(body).toHaveProperty("next");
    expect(body).not.toHaveProperty("error");
  });
});

// ---------------------------------------------------------------------------
// Offline: OpenAPI documents conditional reads with shared definitions.
// ---------------------------------------------------------------------------

describe("public API conditional-read OpenAPI docs (offline)", () => {
  type OpenApiOperation = {
    parameters?: Record<string, unknown>[];
    responses?: Record<string, Record<string, unknown>>;
    description?: string;
  };

  const spec = () => getOpenApiDocument(APP_URL);
  const operation = (path: string): OpenApiOperation => {
    const doc = spec();
    const item = (doc.paths as Record<string, { get?: OpenApiOperation }>)[path];
    expect(item?.get, `Missing GET ${path}`).toBeDefined();
    return item?.get as OpenApiOperation;
  };

  const resolveRef = (node: unknown): Record<string, unknown> => {
    const doc = spec() as unknown as Record<string, unknown>;
    let current = node as Record<string, unknown>;
    const seen = new Set<string>();
    while (typeof current?.["$ref"] === "string") {
      const ref = current["$ref"] as string;
      expect(ref.startsWith("#/"), `External $ref ${ref}`).toBe(true);
      expect(seen.has(ref), `Cyclic $ref ${ref}`).toBe(false);
      seen.add(ref);
      let target: unknown = doc;
      for (const part of ref.replace(/^#\//, "").split("/")) {
        target = (target as Record<string, unknown>)[part];
      }
      expect(target, `Dangling $ref ${ref}`).toBeDefined();
      current = target as Record<string, unknown>;
    }
    return current;
  };

  const ifNoneMatchParam = (path: string): Record<string, unknown> => {
    const params = operation(path).parameters ?? [];
    const found = params.map(resolveRef).find((param) => {
      const name = String(param["name"] ?? "");
      return name.toLowerCase() === "if-none-match" && param["in"] === "header";
    });
    expect(found, `Missing If-None-Match header on GET ${path}`).toBeDefined();
    return found as Record<string, unknown>;
  };

  const notModified = (path: string): Record<string, unknown> => {
    const responses = operation(path).responses ?? {};
    expect(responses["304"], `Missing 304 on GET ${path}`).toBeDefined();
    return resolveRef(responses["304"]);
  };

  const specText = (): string => {
    const doc = spec() as unknown as Record<string, unknown>;
    return JSON.stringify(doc);
  };

  it("advertises If-None-Match on the four read operations with a shared definition", () => {
    const resolved = SPEC_PATHS.map((path) => {
      const param = ifNoneMatchParam(path);
      expect(param["required"]).not.toBe(true);
      const schema = resolveRef(param["schema"]);
      expect(schema["type"]).toBe("string");
      const description = String(param["description"] ?? "");
      expect(description.toLowerCase(), path).toMatch(/etag|validator|conditional/);
      expect(description, path).toMatch(/304/);
      return param;
    });
    for (const param of resolved.slice(1)) {
      expect(JSON.stringify(param)).toBe(JSON.stringify(resolved[0]));
    }
  });

  it("answers a shared bodyless 304 with ETag and Cache-Control headers", () => {
    const resolved = SPEC_PATHS.map((path) => {
      const r304 = notModified(path);
      const description = String(r304["description"] ?? "");
      expect(description.toLowerCase(), path).toMatch(/empty|no body|bodyless|not modified/);
      expect(r304["content"], `${path} 304 carries no body`).toBeUndefined();
      const headers = resolveRef(r304["headers"]) as unknown as Record<string, unknown>;
      // Headers may sit directly on the response or under a shared $ref.
      const lookup = (name: string): Record<string, unknown> => {
        const direct = (r304["headers"] as Record<string, unknown> | undefined)?.[name];
        if (direct !== undefined) return resolveRef(direct);
        const shared = headers?.[name];
        expect(shared, `${path} 304 ${name}`).toBeDefined();
        return resolveRef(shared);
      };
      for (const name of ["ETag", "Cache-Control"]) {
        const header =
          (r304["headers"] as Record<string, unknown> | undefined)?.[name] !== undefined
            ? lookup(name)
            : lookup(name);
        const schema = resolveRef(header["schema"]);
        expect(schema["type"], `${path} 304 ${name}`).toBe("string");
      }
      return r304;
    });
    for (const r304 of resolved.slice(1)) {
      expect(JSON.stringify(r304)).toBe(JSON.stringify(resolved[0]));
    }
  });

  it("carries ETag and Cache-Control headers on every 200", () => {
    const resolved = SPEC_PATHS.map((path) => {
      const responses = operation(path).responses ?? {};
      const r200 = resolveRef(responses["200"]);
      const headers = r200["headers"] as Record<string, unknown> | undefined;
      expect(headers, `Missing 200 headers on GET ${path}`).toBeDefined();
      for (const name of ["ETag", "Cache-Control"]) {
        expect(headers?.[name], `${path} 200 ${name}`).toBeDefined();
        const schema = resolveRef(
          (resolveRef(headers?.[name]) as Record<string, unknown>)["schema"],
        );
        expect(schema["type"], `${path} 200 ${name}`).toBe("string");
      }
      return headers;
    });
    for (const headers of resolved.slice(1)) {
      expect(JSON.stringify(headers)).toBe(JSON.stringify(resolved[0]));
    }
  });

  it("describes admission before 304", () => {
    for (const path of SPEC_PATHS) {
      const r304 = notModified(path);
      const param = ifNoneMatchParam(path);
      const text =
        `${String(r304["description"] ?? "")} ${String(param["description"] ?? "")}`.toLowerCase();
      expect(text, path).toMatch(/429|rate.?limited|admission|budget/);
      expect(text, path).toMatch(/before/);
      expect(text, path).toMatch(/304/);
    }
    // Every conditional operation still documents its 429.
    for (const path of SPEC_PATHS) {
      expect(operation(path).responses?.["429"], path).toBeDefined();
    }
  });

  it("describes remaining freshness for conditional hits", () => {
    for (const path of SPEC_PATHS) {
      const r304 = notModified(path);
      const text = String(r304["description"] ?? "").toLowerCase();
      expect(text, path).toMatch(/remain|left|original/);
      expect(text, path).toMatch(/fresh|max-age|60/);
    }
    const info = String((spec().info as { description?: unknown }).description ?? "");
    expect(info).toContain("60");
    expect(info.toLowerCase()).toMatch(/remain|left|original/);
  });

  it("describes the existing retirement limitations for conditional reads", () => {
    for (const path of SPEC_PATHS) {
      const r304 = notModified(path);
      const text = String(r304["description"] ?? "").toLowerCase();
      expect(text, path).toMatch(/retire/);
      expect(text, path).toMatch(/isolate/);
      expect(text, path).toMatch(/ttl|60/);
    }
    const info = String((spec().info as { description?: unknown }).description ?? "").toLowerCase();
    expect(info).toMatch(/retire/);
    expect(info).toMatch(/isolate/);
    expect(info).toMatch(/not.*(global|edge)|isolate-local|same-isolate/);
  });

  it("promises no If-Modified-Since validator", () => {
    expect(specText().toLowerCase()).not.toContain("modified-since");
    expect(specText().toLowerCase()).not.toContain("if-unmodified-since");
  });

  it("changes no runtime cache or budget", () => {
    // Control: documentation only. The builder must not retune bounds, TTL
    // or the shared read budget to make the docs pass.
    expect(API_PUBLIC_BOUNDS).toEqual({
      defaultPageSize: 20,
      maxPageSize: 20,
      maxBodyBytes: 32 * 1024,
      maxPage: 1000,
    });
    expect(API_PUBLIC_CACHE_TTL_MS).toBe(60_000);
    expect(PUBLIC_EVENT_READS_PER_MINUTE).toBe(60);
    expect(Object.keys(spec().paths).sort()).toEqual([...SPEC_PATHS].sort());
  });

  it("keeps one schema authority for the error envelope", () => {
    // Control: the served spec, the contracts list and the machine-errors
    // table name the same five codes; agents validate against /openapi.json.
    const schemas = spec().components.schemas as unknown as Record<
      string,
      { properties?: Record<string, { enum?: string[] }> }
    >;
    const errorCode = schemas["PublicDataError"]?.properties?.["error"];
    expect(errorCode).toBeDefined();
    const doc = spec() as unknown as {
      components: {
        schemas: {
          PublicDataError: { properties: { error: { properties: { code: { enum: string[] } } } } };
        };
      };
    };
    expect(
      [...doc.components.schemas.PublicDataError.properties.error.properties.code.enum].sort(),
    ).toEqual([...PUBLIC_DATA_ERROR_CODES].sort());
    const root = new URL("../", import.meta.url);
    const machineErrors = readFileSync(new URL("docs/machine-errors.md", root), "utf8");
    for (const code of PUBLIC_DATA_ERROR_CODES) {
      expect(machineErrors).toContain(code);
    }
    expect(machineErrors).toContain("GET /openapi.json");
  });

  it("gives the exact offline machine-contract check with concise machine docs", () => {
    const root = new URL("../", import.meta.url);
    const guide = readFileSync(new URL("docs/machine-interface.md", root), "utf8");
    expect(guide).toContain("npm run check:machine-contract");
    expect(guide.split("\n").length).toBeLessThanOrEqual(120);
    // The change extends the machine surface: unknown paths and validators
    // must be discoverable from the same concise guide.
    expect(guide).toContain("/api/public");
    expect(guide).toContain("not_found");
    expect(guide).toMatch(/If-None-Match/i);
    expect(guide).toMatch(/ETag/);
    expect(guide).toMatch(/304/);
    const packageJson = JSON.parse(readFileSync(new URL("package.json", root), "utf8")) as {
      scripts?: Record<string, string>;
    };
    expect(packageJson.scripts?.["check:machine-contract"]).toBe(
      "node --import tsx ci/check-machine-contract.mjs",
    );
  });

  it("keeps the machine guide short and points at the served spec", () => {
    const root = new URL("../", import.meta.url);
    const guide = readFileSync(new URL("docs/machine-interface.md", root), "utf8");
    expect(guide).toContain("/openapi.json");
    expect(guide).toContain("/mcp");
    expect(guide).toMatch(/20\s+rows/);
    expect(guide).toContain("32 KiB");
  });
});

// ---------------------------------------------------------------------------
// Offline runtime: join + community validators follow weak comparison.
// ---------------------------------------------------------------------------

describe("public API conditional runtime without a database (offline)", () => {
  beforeEach(() => {
    __resetApiPublicCacheForTests();
  });

  const paths = ["/api/public/join", "/api/public/community"] as const;

  const get = (path: string, ifNoneMatch?: string, env: Env & EnvWithThrottle = baseEnv) =>
    app.request(
      path,
      {
        headers: {
          "cf-connecting-ip": "192.0.2.95",
          ...(ifNoneMatch === undefined ? {} : { "if-none-match": ifNoneMatch }),
        },
      },
      env,
    );

  type Baseline = { etag: string; body: string };

  const baseline = async (path: string): Promise<Baseline> => {
    __resetApiPublicCacheForTests();
    const res = await get(path);
    expect(res.status, path).toBe(200);
    const etag = res.headers.get("etag");
    expect(etag, path).not.toBeNull();
    expect(res.headers.get("cache-control"), path).toBe("public, max-age=60");
    expect(res.headers.get("set-cookie"), path).toBeNull();
    return { etag: etag as string, body: await res.text() };
  };

  const expectNotModified = async (res: Response, base: Baseline, path: string) => {
    expect(res.status, path).toBe(304);
    expect(await res.text(), path).toBe("");
    expect(res.headers.get("etag"), path).toBe(base.etag);
    expect(res.headers.get("cache-control"), path).toMatch(/^public, max-age=(59|60)$/);
    expect(res.headers.get("set-cookie"), path).toBeNull();
  };

  const expectFresh = async (res: Response, base: Baseline, path: string) => {
    expect(res.status, path).toBe(200);
    expect(await res.text(), path).toBe(base.body);
    expect(res.headers.get("etag"), path).toBe(base.etag);
    expect(res.headers.get("cache-control"), path).toMatch(/^public, max-age=(59|60)$/);
    expect(res.headers.get("set-cookie"), path).toBeNull();
  };

  const matching = [
    { name: "exact", make: (etag: string) => etag },
    { name: "weak", make: (etag: string) => weakForm(etag) },
    { name: "list containing the exact tag", make: (etag: string) => `${junkEtag(etag)}, ${etag}` },
    {
      name: "list containing the weak tag",
      make: (etag: string) => `${junkEtag(etag)}, ${weakForm(etag)}`,
    },
    { name: "wildcard", make: () => "*" },
  ] as const;

  const nonMatching = [
    { name: "different tag", make: (etag: string) => junkEtag(etag) },
    { name: "weak copy of a different tag", make: (etag: string) => weakForm(junkEtag(etag)) },
    {
      name: "list without the current tag",
      make: (etag: string) => `${junkEtag(etag)}, "also-not-current"`,
    },
  ] as const;

  for (const path of paths) {
    for (const { name, make } of matching) {
      it(`${path} answers an empty 304 for a ${name} validator on a cold build`, async () => {
        const base = await baseline(path);
        __resetApiPublicCacheForTests();
        await expectNotModified(await get(path, make(base.etag)), base, path);
      });

      it(`${path} answers an empty 304 for a ${name} validator on a warm cache`, async () => {
        const base = await baseline(path);
        await expectNotModified(await get(path, make(base.etag)), base, path);
      });
    }

    for (const { name, make } of nonMatching) {
      it(`${path} answers the unchanged 200 body for a ${name} on a cold build`, async () => {
        const base = await baseline(path);
        __resetApiPublicCacheForTests();
        await expectFresh(await get(path, make(base.etag)), base, path);
      });

      it(`${path} answers the unchanged 200 body for a ${name} on a warm cache`, async () => {
        const base = await baseline(path);
        await expectFresh(await get(path, make(base.etag)), base, path);
      });
    }

    it(`${path} serves a 304 hit at t0+59s with max-age=1`, async () => {
      const t0 = Date.now();
      const nowSpy = vi.spyOn(Date, "now").mockReturnValue(t0);
      try {
        __resetApiPublicCacheForTests();
        const first = await get(path);
        expect(first.status).toBe(200);
        const etag = first.headers.get("etag");
        expect(etag).not.toBeNull();
        await first.text();
        nowSpy.mockReturnValue(t0 + 59_000);
        const hit = await get(path, etag as string);
        expect(hit.status, path).toBe(304);
        expect(hit.headers.get("etag"), path).toBe(etag);
        expect(maxAgeOf(hit), path).toBe(1);
      } finally {
        nowSpy.mockRestore();
      }
    });

    it(`${path} refuses before 304 when the shared budget is spent`, async () => {
      // Control: admission runs before any ETag comparison. A matching
      // validator under a spent budget still answers 429, never 304.
      const base = await baseline(path);
      const now = Date.now();
      const ip = "192.0.2.96";
      const hits: { bucket: string; at: number }[] = Array.from({ length: 60 }, () => ({
        bucket: `events-read:${ip}`,
        at: now,
      }));
      const sql = Object.assign(
        async (strings: TemplateStringsArray, ...values: unknown[]) => {
          const statement = strings.join("?");
          if (statement.includes("pg_advisory_xact_lock")) return [];
          if (statement.includes("SELECT count(*)")) {
            const rows = hits.filter((hit) => hit.bucket === values[0] && hit.at > now - 60_000);
            return [{ n: rows.length, wait: 60 }];
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
      const throttled = {
        ...baseEnv,
        THROTTLE_STORE: async () => sql as unknown as Sql,
      } as unknown as Env & EnvWithThrottle;
      const res = await app.request(
        path,
        { headers: { "cf-connecting-ip": ip, "if-none-match": base.etag } },
        throttled,
      );
      expect(res.status, path).toBe(429);
      expect(res.headers.get("retry-after"), path).toBe("60");
      const body = (await res.json()) as PublicErrorBody;
      expect(body.error.code, path).toBe("rate_limited");
      expect(validatePublicSchema(body, "PublicDataError"), path).toEqual([]);
    });
  }
});

// ---------------------------------------------------------------------------
// DB slice: unknown paths with a database, plus preserved boundaries.
// ---------------------------------------------------------------------------

describe("public API contracts with a database", () => {
  let fixture: MemberDataFixture;
  let db: MemberDataFixture["db"];
  let env: Env & EnvWithThrottle;

  beforeAll(async () => {
    fixture = await createMemberDataFixture(process.env.DATABASE_URL as string);
    db = fixture.db;
    env = {
      APP_URL,
      DATABASE_URL: process.env.DATABASE_URL as string,
      DISCORD_INVITE_URL: INVITE_URL,
      DISCORD_BOT_TOKEN: "bot-token-canary-never-served",
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

  const get = (path: string, init: RequestInit = {}, ip = "192.0.2.97") =>
    app.request(path, { ...init, headers: { "cf-connecting-ip": ip, ...init.headers } }, env);

  const seed = (n: number, extra: Record<string, unknown> = {}) =>
    db.insert(events).values({
      eventKey: key(n),
      title: `Game ${n}`,
      status: "published",
      startsAt: new Date(Date.UTC(2099, 0, n, 20)),
      endsAt: new Date(Date.UTC(2099, 0, n, 22)),
      ...extra,
    });

  it.each([...UNKNOWN_PATHS])("GET %s answers JSON with a database present", async (path) => {
    await seed(21);
    await expectUnknownJson(await get(path), path);
  });

  it("answers unknown JSON without touching the database", async () => {
    const offline = {
      ...env,
      get ADMIN_DB(): never {
        throw new Error("Unknown paths must not read the database");
      },
    } as unknown as Env & EnvWithThrottle;
    const res = await app.request(
      "/api/public/unknown",
      { headers: { "cf-connecting-ip": "192.0.2.98" } },
      offline,
    );
    await expectUnknownJson(res, "/api/public/unknown");
  });

  it("keeps known event routes on their existing envelopes", async () => {
    // Controls: the unknown handler must not swallow known behaviour.
    await seed(31);
    const listed = await get("/api/public/events");
    expect(listed.status).toBe(200);
    expect(listed.headers.get("cache-control")).toBe("public, max-age=60");
    const detail = await get(`/api/public/events/${key(31)}`);
    expect(detail.status).toBe(200);
    const missing = await get(`/api/public/events/${key(99)}`);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({
      error: {
        code: "not_found",
        message: "No published event with that key.",
        request_id: expect.any(String),
        next: PUBLIC_DATA_ERROR_NEXT.not_found,
      },
    });
    const invalid = await get("/api/public/events/not-a-key!!!");
    expect(invalid.status).toBe(422);
    const community = await get("/api/public/community");
    expect(community.status).toBe(200);
    const join = await get("/api/public/join");
    expect(join.status).toBe(200);
  });

  it("keeps ICS errors on their existing contracts", async () => {
    // Controls: feed paths never speak the REST envelope.
    await seed(41);
    await seed(42, { status: "draft" });
    const collection = await get("/events.ics");
    expect(collection.status).toBe(200);
    expect(collection.headers.get("content-type")).toBe("text/calendar; charset=utf-8");
    const ok = await get(`/events/${key(41)}.ics`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-disposition")).toBe(`attachment; filename="${key(41)}.ics"`);
    const draft = await get(`/events/${key(42)}.ics`);
    expect(draft.status).toBe(403);
    expect(await draft.text()).toBe("Forbidden");
    for (const path of [`/events/${key(99)}.ics`, "/events/nope.ics"]) {
      const res = await get(path);
      expect(res.status, path).toBe(404);
      expect(res.headers.get("content-type"), path).toContain("text/html");
      expect(await res.text(), path).toMatch(/We cannot find that page|error-heading/);
    }
  });

  it("keeps the shared 429 envelope ahead of any event read", async () => {
    // Control: known-route admission still refuses with JSON before the store.
    const now = Date.now();
    const ip = "192.0.2.99";
    const hits: { bucket: string; at: number }[] = Array.from({ length: 60 }, () => ({
      bucket: `events-read:${ip}`,
      at: now,
    }));
    const sql = Object.assign(
      async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const statement = strings.join("?");
        if (statement.includes("pg_advisory_xact_lock")) return [];
        if (statement.includes("SELECT count(*)")) {
          const rows = hits.filter((hit) => hit.bucket === values[0] && hit.at > now - 60_000);
          return [{ n: rows.length, wait: 60 }];
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
    const throttled = {
      ...env,
      THROTTLE_STORE: async () => sql as unknown as Sql,
    } as unknown as Env & EnvWithThrottle;
    for (const path of ["/api/public/events", `/api/public/events/${key(1)}`]) {
      const res = await app.request(path, { headers: { "cf-connecting-ip": ip } }, throttled);
      expect(res.status, path).toBe(429);
      expect(res.headers.get("retry-after"), path).toBe("60");
      expect(await res.json(), path).toEqual({
        error: {
          code: "rate_limited",
          message: "Too many requests. Try again in 60 seconds.",
          request_id: expect.any(String),
          next: PUBLIC_DATA_ERROR_NEXT.rate_limited,
        },
      });
    }
  });

  it.each(["/api/public/events", `/api/public/events/${key(51)}`])(
    "%s answers 304 for exact, weak, list and wildcard validators",
    async (path) => {
      await seed(51);
      const first = await get(path);
      expect(first.status).toBe(200);
      const etag = first.headers.get("etag");
      expect(etag).not.toBeNull();
      await first.text();
      for (const validator of [
        etag as string,
        weakForm(etag as string),
        `${junkEtag(etag as string)}, ${etag as string}`,
        `${junkEtag(etag as string)}, ${weakForm(etag as string)}`,
        "*",
      ]) {
        const res = await get(path, { headers: { "if-none-match": validator } });
        expect(res.status, `${path} ${validator}`).toBe(304);
        expect(await res.text(), validator).toBe("");
        expect(res.headers.get("etag"), validator).toBe(etag);
      }
      const fresh = await get(path, { headers: { "if-none-match": junkEtag(etag as string) } });
      expect(fresh.status).toBe(200);
    },
  );

  it("serves the canonical empty page conditionally when the game is unknown", async () => {
    await seed(52);
    const first = await get("/api/public/events?game=unknown-game-xyz");
    expect(first.status).toBe(200);
    const etag = first.headers.get("etag");
    expect(etag).not.toBeNull();
    await first.text();
    const cached = await get("/api/public/events?game=unknown-game-xyz", {
      headers: { "if-none-match": etag as string },
    });
    expect(cached.status).toBe(304);
    expect(await cached.text()).toBe("");
    expect(cached.headers.get("etag")).toBe(etag);
  });

  it("refuses before 304 on event reads when the shared budget is spent", async () => {
    await seed(53);
    const first = await get("/api/public/events");
    const etag = first.headers.get("etag");
    expect(etag).not.toBeNull();
    await first.text();
    const now = Date.now();
    const ip = "192.0.2.100";
    const hits: { bucket: string; at: number }[] = Array.from({ length: 60 }, () => ({
      bucket: `events-read:${ip}`,
      at: now,
    }));
    const sql = Object.assign(
      async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const statement = strings.join("?");
        if (statement.includes("pg_advisory_xact_lock")) return [];
        if (statement.includes("SELECT count(*)")) {
          const rows = hits.filter((hit) => hit.bucket === values[0] && hit.at > now - 60_000);
          return [{ n: rows.length, wait: 60 }];
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
    const throttled = {
      ...env,
      THROTTLE_STORE: async () => sql as unknown as Sql,
    } as unknown as Env & EnvWithThrottle;
    for (const path of ["/api/public/events", `/api/public/events/${key(53)}`]) {
      const res = await app.request(
        path,
        { headers: { "cf-connecting-ip": ip, "if-none-match": etag as string } },
        throttled,
      );
      // The collection ETag does not match the detail, so only the
      // collection case proves admission-before-304; the detail case proves
      // admission still runs (429 either way, never a 200/304 read).
      expect(res.status, path).toBe(429);
    }
  });

  it("keeps the agent-runnable freshness proof discoverable", () => {
    // Control: the docs still name a disposable-DB vitest command for api-public.
    const root = new URL("../", import.meta.url);
    const files: string[] = [];
    try {
      for (const entry of readdirSync(new URL("docs/", root), { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith(".md")) {
          files.push(readFileSync(new URL(`docs/${entry.name}`, root), "utf8"));
        }
      }
    } catch {
      // Ignore: assertion below fails clearly.
    }
    try {
      files.push(readFileSync(new URL("README.md", root), "utf8"));
    } catch {
      // Ignore.
    }
    const docs = files.join("\n");
    expect(docs).toContain("DATABASE_URL");
    expect(docs.toLowerCase()).toContain("vitest");
    expect(docs).toMatch(/api-public/);
  });
});
