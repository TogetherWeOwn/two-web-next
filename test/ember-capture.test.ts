import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { parseSigned } from "hono/utils/cookie";
import { describe, expect, it, vi } from "vitest";
import * as fixtureDb from "./helpers/member-data-db";
import {
  createMemorySessionStore,
  hashToken,
  SESSION_ABSOLUTE_MAX_AGE_SECONDS,
  SESSION_ROLE_RECHECK_SECONDS,
  SESSION_TTL_SECONDS,
} from "../src/sessions";
import { SESSION_COOKIE } from "../src/session-cookie";
import { priorGrid } from "../src/hotzones/aggregates";
import { URL } from "node:url";
import {
  CAPTURE_IDENTITIES,
  CAPTURE_INSTANT,
  CAPTURE_KEYS,
  assertCaptureData,
  canonicalJson,
  captureHash,
  captureManifest,
  captureRoutes,
  captureTables,
} from "./helpers/ember-capture-data";
import {
  createEmberCapture,
  mintCaptureSession,
  requireCaptureTarget,
} from "./helpers/ember-capture";

const input = {
  seedId: "ember-capture-v1",
  appUrl: "http://127.0.0.1:8787",
  databaseUrl: "postgres://agent_test@agent-testdb:5432/two_web_next_tog20981231200000",
};
const secret = "synthetic-local-session-signing-material-only";

describe("ember capture admission", () => {
  it("admits only explicit fixture opt-in with loopback HTTP and the existing test DB policy", () => {
    for (const host of ["127.0.0.1", "localhost", "[::1]"]) {
      expect(requireCaptureTarget({ ...input, appUrl: `http://${host}:8787` }, {}).hostname).toBe(
        "agent-testdb",
      );
    }
    expect(
      requireCaptureTarget(
        { ...input, databaseUrl: "postgres://postgres:ci@localhost:5432/postgres" },
        { CI: "true", GITHUB_ACTIONS: "true" } as NodeJS.ProcessEnv,
      ).hostname,
    ).toBe("localhost");
  });

  it("refuses unsafe target strings before a connection or any seed write", async () => {
    const denied = [
      { ...input, seedId: undefined },
      { ...input, seedId: "legacy-e2e" },
      ...[
        "https://localhost:8787",
        "http://example.test",
        "http://localhost.example.test",
        "http://127.0.0.1@evil.test",
        "http://user:pass@localhost",
        "http://localhost/?capture=true",
        "http://localhost/#capture",
        "http://localhost/path",
        "not a URL",
      ].map((appUrl) => ({ ...input, appUrl })),
      ...[
        "postgres://agent_test@production.example.test:5432/two_web_next",
        "postgres://agent_test@staging.example.test:5432/two_web_next",
        "postgres://agent_test:wrong@agent-testdb:5432/two_web_next",
        "postgres://postgres@agent-testdb:5432/two_web_next",
        "postgres://agent_test@agent-testdb:5433/two_web_next",
        "postgres://agent_test@agent-testdb:5432/live",
        "postgres://agent_test@agent-testdb:5432/postgres",
        "postgres://agent_test@agent-testdb:5432/two_web_next",
        "postgres://agent_test@agent-testdb:5432/w15_tests",
        "postgres://agent_test@agent-testdb:5432/two_web_next?options=anything",
        "postgres://agent_test@agent-testdb:5432/two_web_next#x",
        "postgres://postgres:ci@localhost:5432/postgres",
        "",
      ].map((databaseUrl) => ({ ...input, databaseUrl })),
    ];
    const initialize = vi
      .spyOn(fixtureDb, "createMemberDataFixture")
      .mockRejectedValue(new Error("Unexpected fixture initialization"));
    try {
      // Exercise the non-CI refusal even when this test runs in Actions.
      vi.stubEnv("CI", "false");
      vi.stubEnv("GITHUB_ACTIONS", "false");
      for (const target of denied) {
        expect(() => requireCaptureTarget(target, {})).toThrow();
        // Inert refusal inputs, never probes: initialization is intercepted too.
        await expect(createEmberCapture(target as typeof input)).rejects.toThrow();
        expect(initialize).not.toHaveBeenCalled();
      }
    } finally {
      initialize.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it("does not change the independent legacy e2e admission rules", () => {
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import assert from "node:assert/strict";
      import { requireGithubRunner, requireTestDatabase } from "./e2e/ci-only.mjs";
      assert.throws(() => requireGithubRunner({}));
      assert.throws(() => requireTestDatabase(${JSON.stringify(input.databaseUrl)}));
      assert.ok(requireTestDatabase("postgres://agent_test@127.0.0.1:5432/two_web_next").includes("127.0.0.1"));
    `,
      ],
      { cwd: new URL("..", import.meta.url), encoding: "utf8" },
    );
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });
});

describe("ember frozen data and matrix", () => {
  it("pins the complete public manifest, stable data hash and 33 unique route-state bindings", () => {
    const committed = JSON.parse(
      readFileSync(new URL("./fixtures/ember-capture-v1.json", import.meta.url), "utf8"),
    );
    expect(captureManifest()).toEqual(committed);
    expect(captureManifest()).toEqual(captureManifest());
    const routes = captureRoutes();
    expect(routes).toHaveLength(33);
    expect(new Set(routes.map((r) => r.id)).size).toBe(33);
    expect(new Set(routes.map((r) => r.route.replace(/^\/e\/[^/]+$/, "/e/:key"))).size).toBe(28);
    expect(routes.filter((r) => r.expectedStatus === 410).map((r) => r.route)).toEqual([
      `/e/${CAPTURE_KEYS.cancelled}`,
    ]);
    expect(routes.filter((r) => r.expectedStatus === 404).map((r) => r.id)).toEqual([
      "unknown-guest",
    ]);
    expect(routes.find((r) => r.id === "event-paused-member")?.persona).toBe("member");
    expect(routes.find((r) => r.id === "member-guest")?.expectedStatus).toBe(200);
    expect(captureManifest().readiness.pilot).toBe("not_ready");
  });

  it("resolves every data and session prerequisite, including every detail ID", () => {
    const tables = captureTables();
    for (const route of captureRoutes()) {
      expect(captureManifest().sessions[route.persona]).toBeDefined();
      for (const requirement of route.requires) {
        const [table, id] = requirement.split(":");
        if (["joins", "voice", "games", "leaderboard"].includes(table!)) {
          expect(captureManifest().aggregates).toHaveProperty(table!);
        } else {
          expect(tables[table!]!.length).toBeGreaterThan(0);
          if (id) expect(tables[table!]!.some((r) => String(r.id ?? r.user_id) === id)).toBe(true);
        }
      }
    }
    expect(tables.events!.find((r) => r.event_key === CAPTURE_KEYS.paused)).toMatchObject({
      status: "published",
      rsvp_open: false,
    });
    expect(tables.events!.find((r) => r.event_key === CAPTURE_KEYS.cancelled)).toMatchObject({
      status: "cancelled",
    });
    expect(Date.parse(String(tables.events![0]!.starts_at))).toBeGreaterThan(
      Date.parse(CAPTURE_INSTANT),
    );
    expect(Date.parse(String(tables.events![1]!.ends_at))).toBeLessThan(
      Date.parse(CAPTURE_INSTANT),
    );
    expect(tables.rsvps).toContainEqual(expect.objectContaining({ status: "waitlisted" }));
    for (const actor of Object.values(CAPTURE_IDENTITIES))
      expect(actor.userId).toMatch(/^\d{10,25}$/);
  });

  it("keeps going RSVPs within event capacity while retaining the upcoming reserve", () => {
    const tables = captureTables();
    for (const event of tables.events!) {
      const going = tables.rsvps!.filter(
        (row) => row.event_id === event.id && row.status === "going",
      ).length;
      expect(going).toBeLessThanOrEqual(Number(event.capacity));
    }
    expect(tables.events!.find((row) => row.event_key === CAPTURE_KEYS.past)?.capacity).toBe(2);
    expect(tables.events!.find((row) => row.event_key === CAPTURE_KEYS.upcoming)?.capacity).toBe(1);
    expect(tables.rsvps!.find((row) => row.id === 2)?.status).toBe("waitlisted");
  });

  it("fails closed for every missing table or row instead of silently shrinking coverage", () => {
    assertCaptureData(captureTables());
    for (const [table, rows] of Object.entries(captureTables())) {
      const noTable = captureTables();
      delete noTable[table];
      expect(() => assertCaptureData(noTable)).toThrow("capture_invalid");
      for (let i = 0; i < rows.length; i++) {
        const noRow = captureTables();
        noRow[table]!.splice(i, 1);
        expect(() => assertCaptureData(noRow)).toThrow("capture_invalid");
      }
    }
    const drift = captureTables();
    drift.events![0]!.rsvp_open = false;
    expect(() => assertCaptureData(drift)).toThrow();
  });

  it("canonicalizes key order, reuses shipped priors and excludes session material", () => {
    expect(canonicalJson({ b: 2, a: new Date(CAPTURE_INSTANT) })).toBe(
      canonicalJson({ a: CAPTURE_INSTANT, b: 2 }),
    );
    expect(captureHash([1, 2])).not.toBe(captureHash([2, 1]));
    for (const signal of ["voice", "games"] as const) {
      expect(captureManifest().aggregates[signal].hash).toBe(captureHash(priorGrid(signal)));
      expect(priorGrid(signal).cells).toHaveLength(7);
      expect(priorGrid(signal).cells.every((row) => row.length === 24)).toBe(true);
    }
    const manifest = JSON.stringify(captureManifest());
    for (const forbidden of [
      secret,
      "token_hash",
      "status_hash",
      "two_session",
      "cookie",
      "DATABASE_URL",
    ])
      expect(manifest).not.toContain(forbidden);
  });

  it("prints only safe refusal evidence for rejected CLI targets", () => {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "bin/ember-capture.mjs", "verify"],
      {
        cwd: new URL("..", import.meta.url),
        encoding: "utf8",
        env: {
          ...process.env,
          APP_URL: "https://production.example.test",
          DATABASE_URL:
            "postgres://invented:sentinel-not-a-real-secret@production.example.test/live",
          CAPTURE_SEED_ID: "ember-capture-v1",
        },
      },
    );
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("capture_invalid");
    expect(result.stderr).not.toContain("sentinel-not-a-real-secret");
    expect(result.stderr).not.toContain("production.example.test");
  });
});

describe("ember sessions at the frozen instant", () => {
  it("uses real role/TTL/recheck/absolute-age semantics without fixed bearer tokens", async () => {
    let now = Date.parse(CAPTURE_INSTANT);
    const store = createMemorySessionStore(() => now);
    expect(await mintCaptureSession(store, "guest", secret, now)).toBeNull();
    for (const persona of ["member", "moderator"] as const) {
      now = Date.parse(CAPTURE_INSTANT);
      const cookie = await mintCaptureSession(store, persona, secret, now);
      const parsed = await parseSigned(cookie!, secret);
      const token = parsed[SESSION_COOKIE];
      expect(typeof token).toBe("string");
      const hash = await hashToken(token as string);
      expect(await store.get(hash)).toMatchObject({ ...CAPTURE_IDENTITIES[persona], avatar: null });
      expect(await store.roleRecheckDue!(hash)).toBe(false);
      const other = await mintCaptureSession(store, persona, secret, now);
      expect(other).not.toBe(cookie);
      expect(JSON.stringify(captureManifest())).not.toContain(token as string);
      now += SESSION_ROLE_RECHECK_SECONDS * 1000;
      expect(await store.roleRecheckDue!(hash)).toBe(true);
      now = Date.parse(CAPTURE_INSTANT) + SESSION_TTL_SECONDS * 1000 - 1;
      expect(await store.get(hash)).not.toBeNull();
      now += 1;
      expect(await store.get(hash)).toBeNull();
    }
    now = Date.parse(CAPTURE_INSTANT);
    const cookie = await mintCaptureSession(store, "member", secret, now);
    const token = (await parseSigned(cookie!, secret))[SESSION_COOKIE] as string;
    const hash = await hashToken(token);
    await store.renew(hash, new Date(now + (SESSION_ABSOLUTE_MAX_AGE_SECONDS + 60) * 1000));
    now += SESSION_ABSOLUTE_MAX_AGE_SECONDS * 1000 - 1;
    expect(await store.get(hash)).not.toBeNull();
    now += 1;
    expect(await store.get(hash)).toBeNull();
  });

  it("derives expiry from the minting clock even when the store clock lags", async () => {
    const processNow = Date.parse(CAPTURE_INSTANT);
    const store = createMemorySessionStore(() => processNow - 1000);
    const create = vi.spyOn(store, "create");
    const cookie = await mintCaptureSession(store, "member", secret, processNow);
    const token = (await parseSigned(cookie!, secret))[SESSION_COOKIE] as string;
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        expiresAt: new Date(processNow + SESSION_TTL_SECONDS * 1000),
      }),
    );
    expect(await store.get(await hashToken(token))).toMatchObject(CAPTURE_IDENTITIES.member);
  });

  it("refuses unknown personas or weak signing material", async () => {
    const store = createMemorySessionStore();
    await expect(mintCaptureSession(store, "moderator", "short")).rejects.toThrow();
    await expect(mintCaptureSession(store, "reserve" as "member", secret)).rejects.toThrow();
  });
});
