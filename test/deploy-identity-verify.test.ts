// The deploy lanes prove the live Worker answers the identity they just
// recorded before posting a success status: `ci/deploy-identity.mjs verify`
// reads `/version` and `/readyz` and compares the fixed five-field allowlist
// exactly. The endpoints themselves and the allocation/recording halves are
// pinned in web-deploy-identity-acceptance.test.ts and
// web-deploy-identity-cli-acceptance.test.ts; this file adds the verifier and
// the route-inventory references those endpoints need.
//
// route-inventory: GET /readyz
// route-inventory: GET /version
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SHA = "0123456789abcdef0123456789abcdef01234567";
const EVENT = "2026.10.27.3+0123456";
const VERSION = "11111111-2222-4333-8444-555555555555";
const ORIGIN = "https://next.example.test";
const IDENTITY = {
  source_sha: SHA,
  build_id: "1396224001-123456789-1",
  deploy_event_id: EVENT,
  github_deployment_id: "7236504973",
  cloudflare_version_id: VERSION,
};

type Stub = Record<string, unknown>;

function verify(stub: Stub[], extra: string[] = [], origin = ORIGIN) {
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "./ci/test-fetch-stub.mjs",
      "ci/deploy-identity.mjs",
      "verify",
      "--origin",
      origin,
      "--sha",
      SHA,
      "--deploy-event-id",
      EVENT,
      "--deployment-id",
      "7236504973",
      ...extra,
    ],
    {
      cwd: root,
      encoding: "utf8",
      timeout: 20_000,
      env: { PATH: process.env.PATH ?? "", FETCH_STUB_JSON: JSON.stringify(stub) },
    },
  );
  return { status: result.status, out: `${result.stdout}\n${result.stderr}` };
}

const both = (body: unknown, status = 200): Stub[] => [
  { match: "/version", status, body },
  { match: "/readyz", status, body },
];

describe("deploy-identity verify", () => {
  it("accepts the exact recorded identity on both endpoints", () => {
    expect(verify(both(IDENTITY)).status).toBe(0);
    expect(verify(both(IDENTITY), ["--version-id", VERSION]).status).toBe(0);
  });

  it.each([
    [{ ...IDENTITY, source_sha: "f".repeat(40) }, "another commit"],
    [{ ...IDENTITY, deploy_event_id: "2026.10.27.4+0123456" }, "another event ID"],
    [{ ...IDENTITY, github_deployment_id: "1" }, "another Deployment ID"],
    [{ ...IDENTITY, build_id: "not-a-build-id" }, "malformed build ID"],
    [{ ...IDENTITY, cloudflare_version_id: "version-1" }, "non-UUID Version id"],
    [{ ...IDENTITY, extra: "leak" }, "extra field beyond the allowlist"],
    [{ source_sha: SHA }, "missing fields"],
    [[IDENTITY], "array body"],
  ])("refuses a live body with %#", (body, label) => {
    const result = verify(both(body));
    expect(result.status, label as string).not.toBe(0);
    expect(result.out, label as string).not.toMatch(/ERR_MODULE_NOT_FOUND|Cannot find module/);
  });

  it("refuses when the promoted Version id is not the one serving", () => {
    const result = verify(both(IDENTITY), ["--version-id", "22222222-2222-4333-8444-555555555555"]);
    expect(result.status).not.toBe(0);
  });

  it("refuses when either endpoint answers 503, fails to connect or disagrees", () => {
    expect(verify(both({ status: "identity_unavailable" }, 503)).status).not.toBe(0);
    expect(
      verify([
        { match: "/version", body: IDENTITY },
        { match: "/readyz", fail: true },
      ]).status,
    ).not.toBe(0);
    expect(
      verify([
        { match: "/version", body: IDENTITY },
        { match: "/readyz", body: { ...IDENTITY, github_deployment_id: "2" } },
      ]).status,
    ).not.toBe(0);
  });

  it("refuses a non-https origin and a bad Version id before any request", () => {
    expect(verify(both(IDENTITY), [], "http://next.example.test").status).not.toBe(0);
    expect(verify(both(IDENTITY), ["--version-id", "VERSION-1"]).status).not.toBe(0);
  });
});

describe("lane workflows run the identity proof before the success status", () => {
  const read = (path: string) => readFileSync(join(root, path), "utf8");

  it("staging verifies identity after the deployed-revision proof and before the status", () => {
    const wf = read(".github/workflows/deploy.yml");
    const revision = wf.lastIndexOf("bin/revision-check.mjs");
    const verifyAt = wf.indexOf("deploy-identity.mjs verify", revision);
    const success = wf.indexOf("deploy-identity.mjs status", revision);
    expect(verifyAt).toBeGreaterThan(revision);
    expect(success).toBeGreaterThan(verifyAt);
    // The success status follows every public-route smoke in the lane.
    expect(success).toBeGreaterThan(wf.indexOf("Smoke test staging event JSON contract"));
    expect(wf).toContain("deployments: write");
  });

  it("production verifies the promoted Version identity before the receipt and the status", () => {
    const wf = read(".github/workflows/deploy-production.yml");
    const smoke = wf.indexOf("Verify public routes on the promoted version");
    const verifyAt = wf.indexOf("deploy-identity.mjs verify", smoke);
    const receipt = wf.indexOf("Record successful production promotion");
    const success = wf.indexOf("deploy-identity.mjs status", receipt);
    expect(verifyAt).toBeGreaterThan(smoke);
    expect(receipt).toBeGreaterThan(verifyAt);
    expect(success).toBeGreaterThan(wf.indexOf("Upload production promotion proof"));
    expect(wf.slice(verifyAt, receipt)).toContain('--version-id "${PROMOTED_VERSION_ID:?}"');
    expect(wf).toContain("deployments: write");
  });
});
