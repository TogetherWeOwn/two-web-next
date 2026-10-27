// Acceptance: amended web deploy identity (runtime half).
//
// Build identity is compiled in; the environment deployment event is
// attached at runtime. A build-stamp holding the full source SHA, the
// build ID and the input-set digest is generated BEFORE compilation and
// compiled into the web payload, so the same stamp serves staging and
// production bytes. The environment-scoped event ID
// (`YYYY.MM.DD.N+sha7`) and the GitHub Deployment ID are NOT compiled:
// they arrive as Version-scoped non-secret runtime bindings
// (`DEPLOY_EVENT_ID`, `DEPLOYMENT_ENVIRONMENT`, `GITHUB_DEPLOYMENT_ID`)
// together with `CF_VERSION_METADATA.id`.
//
// Contract pinned here (the Builder implements it; do not edit this
// file — return incorrect tests to the Test Author instead):
//
// - `src/build-stamp.ts` is a generated module exporting
//   `BUILD_STAMP = { sourceSha, buildId, inputSetDigest }` with a
//   40-lowercase-hex SHA, a `<repositoryId>-<runId>-<attempt>` decimal
//   build ID (each group 1-20 digits, no leading zeros, at most 64
//   characters in total) and a 64-lowercase-hex input-set digest. The
//   checked-in stamp is valid-shaped; deploy lanes regenerate it before
//   compiling. It never carries an event ID or a GitHub Deployment ID.
// - `src/env.ts` declares the three runtime bindings above.
// - `src/deploy-identity.ts` owns identity validation as pure
//   functions the routes are wired through:
//   `parseDeployEventId(value)` returning `{ date, sequence, sha7 }` or
//   null (canonical means a real zero-padded calendar date, a positive
//   sequence of at most 6 digits without leading zeros, and a lowercase
//   7-hex short SHA; no trimming), `validateBuildStamp(value)`
//   returning the exact three-field stamp or null (extra fields
//   refuse), and `deployIdentity(input)` returning `{ ok: true,
//   identity }` or an ok-false result with no `identity` field.
// - `GET /version` and `GET /readyz` are session-free, database-free,
//   `no-store` JSON endpoints. On a complete, consistent identity both
//   answer 200 with exactly the fixed allowlist and nothing else:
//   `source_sha`, `build_id`, `deploy_event_id`,
//   `github_deployment_id` (digit string), `cloudflare_version_id`.
//   No input-set digest, environment detail, resource IDs, artifact
//   locators or secret-adjacent fields. The Cloudflare Version ID must
//   be a canonical lowercase UUID for an identity success claim (the
//   looser existing `/up` revision surface is preserved separately).
// - Fail closed: absent, malformed or non-string bindings, an unknown
//   `DEPLOYMENT_ENVIRONMENT` (only `staging` and `production` exist),
//   an event ID whose sha7 disagrees with the compiled stamp, a
//   Version tag whose parsed SHA disagrees with the stamp, or an
//   invalid stamp never yields success. Both endpoints answer 503,
//   keep `no-store`, set no cookie, echo no submitted binding or secret
//   values, and expose none of the five identity keys on failure. An
//   absent or unparseable Version tag does not block an otherwise
//   valid identity (the tag surface keeps its existing tolerance).
// - `/up` semantics are unchanged: identity bindings neither move its
//   status nor add identity fields to its body, and the existing
//   commit/UUID parsing in `src/up-revision.ts` and
//   `src/release-tag.ts` keeps working byte-for-byte.
// - Kit must never shadow the two endpoints: route ownership resolves
//   `/readyz` and `/version` to Hono even under a manifest claiming
//   them for Kit.
//
// The allocation, stamping CLI, Deployment recording and workflow
// ordering halves live in web-deploy-identity-cli-acceptance.test.ts.
// Everything here runs offline against the real app and local strings.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "./app";
import type { Env } from "../src/env";
import { buildShaFromTag, releaseFields } from "../src/release-tag";
import { resolveRouteOwner } from "../src/route-ownership";
import { revisionReadiness } from "../src/up-revision";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string): string => readFileSync(join(root, p), "utf8");

const SHA_A = "0123456789abcdef0123456789abcdef01234567";
const SHA_B = "fedcba9876543210fedcba9876543210fedcba98";
const EVENT_A = "2026.10.27.3+0123456";
const VERSION_UUID = "11111111-2222-4333-8444-555555555555";
const DIGEST = "ab".repeat(32);
const STAMP = { sourceSha: SHA_A, buildId: "1396224001-123456789-1", inputSetDigest: DIGEST };
const IDENTITY_KEYS = [
  "build_id",
  "cloudflare_version_id",
  "deploy_event_id",
  "github_deployment_id",
  "source_sha",
];

// --- Dynamic probe for the Builder-owned pure module -------------------
// Bundling to a scratch file keeps this suite collectable (and the
// repo typecheckable) before src/deploy-identity.ts exists: each case
// below then fails individually with the missing-contract message.
type Stamp = { sourceSha: string; buildId: string; inputSetDigest: string };
type IdentityInput = {
  stamp: unknown;
  deployEventId: unknown;
  deploymentEnvironment: unknown;
  githubDeploymentId: unknown;
  cfVersionMetadata: { id?: unknown; tag?: unknown } | null | undefined;
};
type IdentityModule = {
  parseDeployEventId: (value: unknown) => { date: string; sequence: number; sha7: string } | null;
  validateBuildStamp: (value: unknown) => Stamp | null;
  deployIdentity: (input: IdentityInput) => unknown;
};

let moduleProbe: Promise<{ mod: IdentityModule | null; error: string }> | null = null;
function loadIdentityModule(): Promise<{ mod: IdentityModule | null; error: string }> {
  if (moduleProbe) return moduleProbe;
  moduleProbe = (async () => {
    const scratchRoot =
      process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.PAPERCLIP_SCRATCH_DIR ?? tmpdir();
    const scratch = mkdtempSync(join(scratchRoot, "web-deploy-identity-"));
    try {
      const outfile = join(scratch, "deploy-identity.mjs");
      await build({
        entryPoints: [join(root, "src/deploy-identity.ts")],
        bundle: true,
        platform: "node",
        format: "esm",
        logLevel: "silent",
        outfile,
      });
      const loaded = (await import(pathToFileURL(outfile).href)) as Partial<IdentityModule>;
      const missing = (["parseDeployEventId", "validateBuildStamp", "deployIdentity"] as const)
        .filter((name) => typeof loaded[name] !== "function")
        .join(", ");
      if (missing) return { mod: null, error: `src/deploy-identity.ts lacks: ${missing}` };
      return { mod: loaded as IdentityModule, error: "" };
    } catch (err) {
      return { mod: null, error: `src/deploy-identity.ts unavailable: ${String(err)}` };
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  })();
  return moduleProbe;
}

async function requireIdentity(): Promise<IdentityModule> {
  const { mod, error } = await loadIdentityModule();
  expect(mod, error).not.toBeNull();
  return mod as IdentityModule;
}

function validInput(over: Partial<IdentityInput> = {}): IdentityInput {
  return {
    stamp: STAMP,
    deployEventId: EVENT_A,
    deploymentEnvironment: "staging",
    githubDeploymentId: "7236504973",
    cfVersionMetadata: { id: VERSION_UUID, tag: SHA_A },
    ...over,
  };
}

function expectRefused(result: unknown) {
  const record = result as Record<string, unknown>;
  expect(record.ok).toBe(false);
  expect(record).not.toHaveProperty("identity");
}

// --- Checked-in build stamp discovery (for the HTTP cases) -------------
function checkedInStamp(): Stamp {
  const text = read("src/build-stamp.ts");
  const grab = (name: string): string => {
    const match = new RegExp(`${name}:\\s*"([^"]*)"`).exec(text);
    expect(match, `src/build-stamp.ts carries ${name}`).not.toBeNull();
    return (match as RegExpExecArray)[1] as string;
  };
  return {
    sourceSha: grab("sourceSha"),
    buildId: grab("buildId"),
    inputSetDigest: grab("inputSetDigest"),
  };
}

const SECRET_SENTINEL = "sentinel-secret-value-must-never-be-echoed";
const APP_URL = "https://next.example.test";

function identityEnv(stamp: Stamp, over: Record<string, unknown> = {}): Env {
  return {
    APP_URL,
    DISCORD_CLIENT_ID: "client-id",
    DISCORD_GUILD_ID: "326474832151838730",
    DISCORD_INVITE_URL: "https://discord.gg/invite",
    DISCORD_CLIENT_SECRET: SECRET_SENTINEL,
    DISCORD_BOT_TOKEN: SECRET_SENTINEL,
    SESSION_SECRET: SECRET_SENTINEL,
    CF_VERSION_METADATA: { id: VERSION_UUID, tag: stamp.sourceSha },
    DEPLOY_EVENT_ID: `2026.10.27.1+${stamp.sourceSha.slice(0, 7)}`,
    DEPLOYMENT_ENVIRONMENT: "staging",
    GITHUB_DEPLOYMENT_ID: "7236504973",
    ...over,
  } as unknown as Env;
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

// --- Requirement 7 controls: existing parsing is preserved -------------
// These pass on current main and must keep passing after the slice.
describe("preserved release-tag and up-revision parsing (controls)", () => {
  it("still parses the bare-SHA and composite production tags", () => {
    expect(buildShaFromTag(SHA_A)).toBe(SHA_A);
    expect(buildShaFromTag(`${SHA_A}-123456789-2`)).toBe(SHA_A);
    expect(releaseFields({ tag: `${SHA_A}-123456789-2` })).toEqual({
      build_sha: SHA_A,
      release: SHA_A,
    });
  });

  it("still refuses arbitrary tags instead of echoing them", () => {
    expect(buildShaFromTag("manual-deploy")).toBeNull();
    expect(buildShaFromTag(EVENT_A)).toBeNull();
    expect(releaseFields(undefined)).toEqual({ build_sha: null, release: null });
  });

  it("still surfaces any non-empty Version id on /up with a parsed commit", () => {
    expect(revisionReadiness({ id: "version-1", tag: `${SHA_A}-123456789-2` })).toEqual({
      revision: { version_id: "version-1", commit: SHA_A },
    });
    expect(revisionReadiness(undefined)).toEqual({});
    expect(revisionReadiness({ id: "", tag: SHA_A })).toEqual({});
  });
});

// --- Requirement 4/5 shapes: canonical event IDs -----------------------
describe("parseDeployEventId canonical shape", () => {
  it("parses a canonical event ID into date, sequence and sha7", async () => {
    const mod = await requireIdentity();
    expect(mod.parseDeployEventId(EVENT_A)).toEqual({
      date: "2026.10.27",
      sequence: 3,
      sha7: "0123456",
    });
    expect(mod.parseDeployEventId("2026.02.28.999999+fedcba9")).toEqual({
      date: "2026.02.28",
      sequence: 999999,
      sha7: "fedcba9",
    });
  });

  it.each([
    "2026.02.30.1+0123456",
    "2026.13.01.1+0123456",
    "2026.1.27.1+0123456",
    "2026.10.27.01+0123456",
    "2026.10.27.0+0123456",
    "2026.10.27.1000000+0123456",
    "2026.10.27.1+012345G",
    "2026.10.27.1+ABCDEF0",
    "2026.10.27.1+012345",
    "2026.10.27.1+01234567",
    "2026.10.27.1",
    "2026.10.27",
    "v2026.10.27.1+0123456",
    "2026-10-27.1+0123456",
    ` ${EVENT_A}`,
    `${EVENT_A} `,
    "",
    42,
    null,
    undefined,
  ])("refuses the noncanonical event ID %j", async (value) => {
    const mod = await requireIdentity();
    expect(mod.parseDeployEventId(value)).toBeNull();
  });
});

// --- Requirement 1 shapes: the compiled build stamp --------------------
describe("validateBuildStamp canonical shape", () => {
  it("accepts the exact three-field stamp", async () => {
    const mod = await requireIdentity();
    expect(mod.validateBuildStamp(STAMP)).toEqual(STAMP);
  });

  it.each([
    [{ ...STAMP, sourceSha: SHA_A.toUpperCase() }, "uppercase source SHA"],
    [{ ...STAMP, sourceSha: SHA_A.slice(0, 39) }, "short source SHA"],
    [{ ...STAMP, sourceSha: "unknown" }, "unstamped placeholder"],
    [{ ...STAMP, buildId: "123456789-1" }, "two-group build ID"],
    [{ ...STAMP, buildId: "1396224001-123456789" }, "missing attempt group"],
    [{ ...STAMP, buildId: "1396224001-0123456789-1" }, "leading-zero run group"],
    [{ ...STAMP, buildId: "1396224001-123456789-0" }, "zero attempt group"],
    [{ ...STAMP, buildId: "repo-123456789-1" }, "non-decimal group"],
    [{ ...STAMP, buildId: `${"1".repeat(21)}-1-1` }, "overlong group"],
    [{ ...STAMP, buildId: " 1396224001-123456789-1" }, "padded build ID"],
    [{ ...STAMP, inputSetDigest: DIGEST.toUpperCase() }, "uppercase digest"],
    [{ ...STAMP, inputSetDigest: DIGEST.slice(0, 63) }, "short digest"],
    [{ sourceSha: SHA_A, buildId: STAMP.buildId }, "missing digest"],
    [{ ...STAMP, deployEventId: EVENT_A }, "compiled event ID field"],
    [null, "null stamp"],
    ["stamp", "string stamp"],
  ])("refuses a stamp case %#", async (value, label) => {
    const mod = await requireIdentity();
    expect(mod.validateBuildStamp(value), label as string).toBeNull();
  });
});

// --- Requirements 2-4: the pure runtime identity decision --------------
describe("deployIdentity fail-closed decision", () => {
  it("returns exactly the five-field allowlist on a consistent identity", async () => {
    const mod = await requireIdentity();
    expect(mod.deployIdentity(validInput())).toEqual({
      ok: true,
      identity: {
        source_sha: SHA_A,
        build_id: STAMP.buildId,
        deploy_event_id: EVENT_A,
        github_deployment_id: "7236504973",
        cloudflare_version_id: VERSION_UUID,
      },
    });
  });

  it("accepts production as the other environment", async () => {
    const mod = await requireIdentity();
    const result = mod.deployIdentity(validInput({ deploymentEnvironment: "production" }));
    expect((result as { ok: unknown }).ok).toBe(true);
  });

  it("tolerates an absent or unparseable Version tag when the stamp agrees elsewhere", async () => {
    const mod = await requireIdentity();
    for (const tag of [undefined, "manual-deploy", `${SHA_A}-123456789-2`]) {
      const result = mod.deployIdentity(
        validInput({ cfVersionMetadata: { id: VERSION_UUID, tag } }),
      );
      expect((result as { ok: unknown }).ok, `tag ${String(tag)}`).toBe(true);
    }
  });

  it.each([
    [{ deployEventId: undefined }, "absent event ID"],
    [{ deployEventId: "" }, "empty event ID"],
    [{ deployEventId: "not-an-event-id" }, "malformed event ID"],
    [{ deployEventId: "2026.10.27.1+fedcba9" }, "event ID for another commit"],
    [{ deployEventId: 20261027 }, "numeric event ID"],
    [{ deploymentEnvironment: undefined }, "absent environment"],
    [{ deploymentEnvironment: "Production" }, "capitalised environment"],
    [{ deploymentEnvironment: "prod" }, "abbreviated environment"],
    [{ deploymentEnvironment: "qa" }, "unknown environment"],
    [{ githubDeploymentId: undefined }, "absent GitHub Deployment ID"],
    [{ githubDeploymentId: "" }, "empty GitHub Deployment ID"],
    [{ githubDeploymentId: "0" }, "zero GitHub Deployment ID"],
    [{ githubDeploymentId: "007" }, "leading-zero GitHub Deployment ID"],
    [{ githubDeploymentId: "7236504973 " }, "padded GitHub Deployment ID"],
    [{ githubDeploymentId: "72.5" }, "fractional GitHub Deployment ID"],
    [{ githubDeploymentId: "1".repeat(21) }, "overlong GitHub Deployment ID"],
    [{ githubDeploymentId: 7236504973 }, "numeric GitHub Deployment ID"],
    [{ cfVersionMetadata: undefined }, "absent Version metadata"],
    [{ cfVersionMetadata: null }, "null Version metadata"],
    [{ cfVersionMetadata: { tag: SHA_A } }, "Version metadata without id"],
    [{ cfVersionMetadata: { id: "version-1", tag: SHA_A } }, "non-UUID Version id"],
    [
      { cfVersionMetadata: { id: "AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE", tag: SHA_A } },
      "uppercase Version UUID",
    ],
    [{ cfVersionMetadata: { id: VERSION_UUID, tag: SHA_B } }, "tag SHA disagrees with stamp"],
    [
      { cfVersionMetadata: { id: VERSION_UUID, tag: `${SHA_B}-123456789-1` } },
      "composite tag SHA disagrees with stamp",
    ],
    [{ stamp: { ...STAMP, sourceSha: SHA_B } }, "stamp for another commit (suffix and tag)"],
    [{ stamp: null }, "absent stamp"],
    [{ stamp: { ...STAMP, inputSetDigest: "unknown" } }, "invalid stamp digest"],
  ])("refuses success case %#", async (over, _label) => {
    const mod = await requireIdentity();
    expectRefused(mod.deployIdentity(validInput(over)));
  });

  it("never lets stamp-shaped extra input fields override the compiled stamp", async () => {
    const mod = await requireIdentity();
    const forged = {
      ...validInput(),
      sourceSha: SHA_B,
      buildId: "1396224001-999-9",
      inputSetDigest: "cd".repeat(32),
    };
    expect(mod.deployIdentity(forged)).toEqual({
      ok: true,
      identity: {
        source_sha: SHA_A,
        build_id: STAMP.buildId,
        deploy_event_id: EVENT_A,
        github_deployment_id: "7236504973",
        cloudflare_version_id: VERSION_UUID,
      },
    });
  });
});

// --- Requirements 1-2: compiled stamp and binding declarations ---------
describe("compiled stamp and runtime binding declarations", () => {
  it("checks in a valid-shaped generated build stamp with no compiled event identity", () => {
    const stamp = checkedInStamp();
    expect(stamp.sourceSha).toMatch(/^[0-9a-f]{40}$/);
    expect(stamp.buildId).toMatch(/^[1-9]\d{0,19}-[1-9]\d{0,19}-[1-9]\d{0,19}$/);
    expect(stamp.inputSetDigest).toMatch(/^[0-9a-f]{64}$/);
    const text = read("src/build-stamp.ts");
    expect(text).not.toMatch(/\d{4}\.\d{2}\.\d{2}\.\d+\+[0-9a-f]{7}/);
    expect(text).not.toContain("DEPLOY_EVENT_ID");
    expect(text).not.toContain("GITHUB_DEPLOYMENT_ID");
  });

  it("declares the three Version-scoped runtime bindings on the web Env", () => {
    const envSource = read("src/env.ts");
    for (const name of ["DEPLOY_EVENT_ID", "DEPLOYMENT_ENVIRONMENT", "GITHUB_DEPLOYMENT_ID"]) {
      expect(envSource, `Env declares ${name}`).toContain(name);
    }
  });
});

// --- Requirements 3-4: the HTTP endpoints -------------------------------
describe("/version and /readyz endpoints", () => {
  it("exist and fail closed (503, not 404) when identity bindings are absent", async () => {
    const env = {
      APP_URL,
      DISCORD_CLIENT_ID: "client-id",
      DISCORD_GUILD_ID: "326474832151838730",
      DISCORD_INVITE_URL: "https://discord.gg/invite",
      DISCORD_CLIENT_SECRET: SECRET_SENTINEL,
      DISCORD_BOT_TOKEN: SECRET_SENTINEL,
      SESSION_SECRET: SECRET_SENTINEL,
    } as unknown as Env;
    for (const path of ["/version", "/readyz"]) {
      const res = await app.request(path, { headers: { accept: "application/json" } }, env);
      expect(res.status, path).toBe(503);
      expect(res.headers.get("cache-control"), path).toContain("no-store");
    }
  });

  it("answers both endpoints with the exact allowlist on a valid identity", async () => {
    const stamp = checkedInStamp();
    const env = identityEnv(stamp);
    const expected = {
      source_sha: stamp.sourceSha,
      build_id: stamp.buildId,
      deploy_event_id: `2026.10.27.1+${stamp.sourceSha.slice(0, 7)}`,
      github_deployment_id: "7236504973",
      cloudflare_version_id: VERSION_UUID,
    };
    for (const path of ["/version", "/readyz"]) {
      const res = await app.request(path, { headers: { accept: "application/json" } }, env);
      expect(res.status, path).toBe(200);
      expect(res.headers.get("cache-control"), path).toContain("no-store");
      expect(res.headers.get("content-type"), path).toContain("application/json");
      expect(res.headers.get("set-cookie"), path).toBeNull();
      const body = (await res.json()) as Record<string, unknown>;
      expect(Object.keys(body).sort(), path).toEqual(IDENTITY_KEYS);
      expect(body, path).toEqual(expected);
    }
  });

  it("is session-free: a forged cookie changes nothing and sets no cookie", async () => {
    const stamp = checkedInStamp();
    const env = identityEnv(stamp);
    for (const path of ["/version", "/readyz"]) {
      const bare = await app.request(path, { headers: { accept: "application/json" } }, env);
      const forged = await app.request(
        path,
        { headers: { accept: "application/json", cookie: "session=forged-value" } },
        env,
      );
      expect(forged.status, path).toBe(bare.status);
      expect(await forged.text(), path).toBe(await bare.text());
      expect(forged.headers.get("set-cookie"), path).toBeNull();
    }
  });

  it.each([
    [{ DEPLOY_EVENT_ID: undefined }, "absent event ID"],
    [{ DEPLOY_EVENT_ID: "malformed-SENTINEL-event" }, "malformed event ID"],
    [{ DEPLOYMENT_ENVIRONMENT: "qa" }, "unknown environment"],
    [{ DEPLOYMENT_ENVIRONMENT: "Production" }, "capitalised environment"],
    [{ DEPLOYMENT_ENVIRONMENT: undefined }, "absent environment"],
    [{ GITHUB_DEPLOYMENT_ID: undefined }, "absent GitHub Deployment ID"],
    [{ GITHUB_DEPLOYMENT_ID: "abc-SENTINEL" }, "malformed GitHub Deployment ID"],
    [{ CF_VERSION_METADATA: undefined }, "absent Version metadata"],
    [
      { CF_VERSION_METADATA: { id: "version-SENTINEL", tag: "0".repeat(40) } },
      "non-UUID Version id",
    ],
  ])("fails closed on both endpoints case %#", async (over, _label) => {
    const stamp = checkedInStamp();
    const env = identityEnv(stamp, over);
    for (const path of ["/version", "/readyz"]) {
      const res = await app.request(path, { headers: { accept: "application/json" } }, env);
      expect(res.status, path).toBe(503);
      expect(res.headers.get("cache-control"), path).toContain("no-store");
      expect(res.headers.get("set-cookie"), path).toBeNull();
      const text = await res.text();
      expect(text, path).not.toContain(SECRET_SENTINEL);
      expect(text, path).not.toContain("SENTINEL");
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(text);
      } catch (err) {
        expect(err, path).toBeInstanceOf(SyntaxError);
      }
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const key of IDENTITY_KEYS)
          expect(parsed, `${path} key ${key}`).not.toHaveProperty(key);
      }
    }
  });

  it("fails closed when the event ID names another commit than the stamp", async () => {
    const stamp = checkedInStamp();
    const otherSha7 = stamp.sourceSha.startsWith("0000000") ? "1111111" : "0000000";
    const env = identityEnv(stamp, { DEPLOY_EVENT_ID: `2026.10.27.1+${otherSha7}` });
    for (const path of ["/version", "/readyz"]) {
      const res = await app.request(path, { headers: { accept: "application/json" } }, env);
      expect(res.status, path).toBe(503);
    }
  });

  it("fails closed when the Version tag SHA disagrees with the compiled stamp", async () => {
    const stamp = checkedInStamp();
    const otherSha = stamp.sourceSha.startsWith("0") ? `1${"0".repeat(39)}` : "0".repeat(40);
    const env = identityEnv(stamp, {
      CF_VERSION_METADATA: { id: VERSION_UUID, tag: `${otherSha}-123456789-1` },
    });
    for (const path of ["/version", "/readyz"]) {
      const res = await app.request(path, { headers: { accept: "application/json" } }, env);
      expect(res.status, path).toBe(503);
    }
  });

  it("never answers a non-GET request with an identity success", async () => {
    const stamp = checkedInStamp();
    const env = identityEnv(stamp);
    for (const path of ["/version", "/readyz"]) {
      const res = await app.request(
        path,
        { method: "POST", headers: { accept: "application/json" } },
        env,
      );
      expect(res.status, path).not.toBe(200);
      expect(await res.text(), path).not.toContain(stamp.sourceSha);
    }
  });
});

// --- Requirement 3: /up is untouched by identity state ------------------
describe("/up stays unchanged (control)", () => {
  it("keeps its revision surface and gains no identity fields", async () => {
    const stamp = checkedInStamp();
    for (const over of [{}, { DEPLOY_EVENT_ID: "malformed" }]) {
      const env = identityEnv(stamp, over);
      const res = await app.request("/up", {}, env);
      // No database is bound in this harness, so /up is degraded exactly
      // as on current main; identity state must not move that verdict.
      expect(res.status).toBe(503);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.revision).toEqual({ version_id: VERSION_UUID, commit: stamp.sourceSha });
      for (const key of IDENTITY_KEYS) expect(body).not.toHaveProperty(key);
    }
  });
});

// --- Requirement 3: Kit can never shadow the endpoints ------------------
describe("route ownership keeps the identity endpoints on Hono", () => {
  it("resolves /readyz and /version to Hono under a claiming manifest", () => {
    const manifest = [
      { method: "GET", path: "/readyz", enabled: true },
      { method: "GET", path: "/version", enabled: true },
    ];
    expect(resolveRouteOwner({ method: "GET", path: "/readyz" }, manifest)).toBe("hono");
    expect(resolveRouteOwner({ method: "GET", path: "/version" }, manifest)).toBe("hono");
    expect(resolveRouteOwner({ method: "GET", path: "/version/" }, manifest)).toBe("hono");
  });
});
