// Acceptance: amended web deploy identity (allocation, stamping and
// recording half). The runtime endpoints and pure validation live in
// web-deploy-identity-acceptance.test.ts.
//
// Contract pinned here (the Builder implements it; do not edit this
// file — return incorrect tests to the Test Author instead). One CLI,
// `ci/deploy-identity.mjs`, run with Node like every other gate in
// ci/, owns all three jobs. It speaks to api.github.com with `fetch`
// and a `GITHUB_TOKEN` bearer (the repo gate convention in
// ci/production-deploy-gate.mjs), paginates with explicit
// `per_page`/`page` parameters, reads JSON response bodies only, and
// never echoes upstream bodies, tokens or file contents in its output.
//
// - `stamp --sha <40hex> --build-id <id> --out <path> --input <relpath>...`
//   generates `src/build-stamp.ts` BEFORE any compilation. The output
//   is deterministic: the input-set digest is the SHA-256 of the
//   sha256sum-format lines (`<sha256hex>  <path>\n`) over the explicit
//   input files sorted by POSIX relative path, so argument order and
//   mtimes never matter. Missing files, absolute or parent-escaping
//   paths, duplicate inputs, an empty input set, a malformed SHA or a
//   malformed build ID refuse without writing the output. Which files
//   the lanes list is the Builder's choice in this slice; completeness
//   of the inventory belongs to the artifact-manifest slice.
// - `next --environment staging|production --sha <40hex>
//   [--date YYYY.MM.DD] [--deployments-json <file>] [--saved <file>]`
//   prints exactly one line `DEPLOY_EVENT_ID=YYYY.MM.DD.N+sha7`. The
//   counter is environment-scoped and UTC-dated (default: today UTC):
//   N is one plus the count of that environment's canonical Deployment
//   records created on that UTC date. Enumeration is bounded and
//   complete: newest first, 100 rows per page, stopping at the first
//   row older than the date or a short page, and refusing past six
//   pages without a terminator instead of minting a duplicate. Only
//   rows whose description is a canonical event ID count (automatic
//   `environment:` job rows carry none); a description that claims an
//   event ID shape but is not canonical, a payload
//   `deploy_event_id` disagreeing with the description, a row without
//   a parseable zoned `created_at`, a non-object row, an unknown
//   environment, a bad date/SHA, more than 600 same-day rows, a
//   transport or HTTP failure, a non-array page, or a missing
//   `GITHUB_REPOSITORY` in live mode all fail closed. A `--saved`
//   file is the one attempt's saved record: absent, the allocated ID
//   is written there; present with a canonical ID for the same commit
//   it is reused verbatim (even across a UTC date change) without
//   reallocating; present but malformed or for another commit it
//   refuses instead of reallocating.
// - `create --environment ... --sha ... --deploy-event-id ...`
//   creates the canonical GitHub Deployment BEFORE the version upload
//   that carries its numeric ID as a runtime binding, and prints one
//   line `GITHUB_DEPLOYMENT_ID=<id>`. Creation is idempotent: an
//   existing canonical record for the same environment, event ID and
//   full SHA is reused with no second create; the same event ID bound
//   to a different full SHA refuses. `status --deployment-id <n>
//   --deploy-event-id ... --state success|failure` posts the truthful
//   final status after the lane's health/identity proof (or, on lane
//   failure, the failure status). Both subcommands share validation
//   (canonical env/SHA/event ID, event-ID suffix equals the SHA,
//   positive integer Deployment ID, https-only credential-free
//   optional URLs) and support `--dry-run`, which prints the exact
//   request JSON without network: `{ create: {...} }` for create
//   (ref = SHA, task `deploy`, `production_environment` only for
//   production, `auto_merge: false`, `required_contexts: []`,
//   description and `payload.deploy_event_id` carrying the event ID,
//   plus `payload.rollback: true` only with `--rollback`) and
//   `{ status: {...} }` for status (`state`, description = event ID,
//   optional `log_url`/`environment_url` keys only when passed). A
//   create or status transport/HTTP failure, or a create response
//   without a positive integer `id`, fails closed. Recording is a
//   forward-lane concern only: nothing here may gate the rollback
//   workflow (see the workflow pins at the bottom).
//
// Lane workflows (staging `deploy.yml`, production
// `deploy-production.yml`) run, in order: stamp generation before the
// first compile, allocation and Deployment creation before the
// Workers deploy/version upload, the three identity bindings passed
// as `--var` values on that deploy/upload, and a truthful final
// status after the existing deployed-revision/public-route proof,
// including a failure status on lane failure. The existing Worker
// version tags (bare SHA on staging, `<sha>-<run>-<attempt>` on
// production) are preserved, never replaced by an event ID. No
// checked-in wrangler config hardcodes a per-deploy event or
// Deployment ID.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string): string => readFileSync(join(root, p), "utf8");
const SCRIPT = join(root, "ci/deploy-identity.mjs");
const FETCH_STUB = "./ci/test-fetch-stub.mjs";

const SHA_A = "0123456789abcdef0123456789abcdef01234567";
const SHA_B = "fedcba9876543210fedcba9876543210fedcba98";
const DATE = "2026.10.27";
const EVENT_N3 = "2026.10.27.3+0123456";
const TOKEN_SENTINEL = "fixture-token-sentinel-must-never-be-echoed";
const CONTENT_SENTINEL = "fixture-file-content-sentinel";

type CliResult = { status: number | null; stdout: string; stderr: string };
type StubEntry = Record<string, unknown>;

const tempDirs: string[] = [];
function tempDir(): string {
  const scratchRoot =
    process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.PAPERCLIP_SCRATCH_DIR ?? tmpdir();
  const dir = mkdtempSync(join(scratchRoot, "web-deploy-identity-cli-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function runCli(
  args: string[],
  opts: { cwd?: string; env?: Record<string, string>; stub?: StubEntry[] } = {},
): CliResult {
  const argv = [
    ...(opts.stub ? ["--import", FETCH_STUB] : []),
    ...(opts.cwd ? [SCRIPT] : ["ci/deploy-identity.mjs"]),
    ...args,
  ];
  const result = spawnSync(process.execPath, argv, {
    cwd: opts.cwd ?? root,
    encoding: "utf8",
    timeout: 20_000,
    env: {
      PATH: process.env.PATH ?? "",
      ...(opts.env ?? {}),
      ...(opts.stub ? { FETCH_STUB_JSON: JSON.stringify(opts.stub) } : {}),
    },
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function expectRefusal(result: CliResult, label: string) {
  expect(result.status, label).not.toBe(0);
  // A refusal must come from the CLI's own validation, never from the
  // module simply not existing yet.
  expect(`${result.stdout}\n${result.stderr}`, label).not.toMatch(
    /ERR_MODULE_NOT_FOUND|Cannot find module/,
  );
}

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

// --- Requirement 1: pre-build stamp generation -------------------------
describe("deploy-identity stamp", () => {
  function stampFixture() {
    const dir = tempDir();
    writeFileSync(join(dir, "a.txt"), "alpha\n");
    mkdirSync(join(dir, "dir"));
    writeFileSync(join(dir, "dir/b.txt"), "beta");
    writeFileSync(join(dir, "secret.txt"), CONTENT_SENTINEL);
    const expectedDigest = sha256(`${sha256("alpha\n")}  a.txt\n${sha256("beta")}  dir/b.txt\n`);
    return { dir, expectedDigest };
  }

  it("writes a deterministic generated stamp module regardless of input order", () => {
    const { dir, expectedDigest } = stampFixture();
    const out1 = join(dir, "build-stamp-1.ts");
    const out2 = join(dir, "build-stamp-2.ts");
    const base = ["stamp", "--sha", SHA_A, "--build-id", "1396224001-123456789-1"];
    const first = runCli([...base, "--out", out1, "--input", "dir/b.txt", "--input", "a.txt"], {
      cwd: dir,
    });
    expect(first.status, first.stderr).toBe(0);
    const second = runCli([...base, "--out", out2, "--input", "a.txt", "--input", "dir/b.txt"], {
      cwd: dir,
    });
    expect(second.status, second.stderr).toBe(0);
    const text = readFileSync(out1, "utf8");
    expect(text).toBe(readFileSync(out2, "utf8"));
    expect(text.split("\n")[0]).toBe("// GENERATED by ci/deploy-identity.mjs. Do not edit.");
    expect(text).toContain(`sourceSha: "${SHA_A}"`);
    expect(text).toContain('buildId: "1396224001-123456789-1"');
    expect(text).toContain(`inputSetDigest: "${expectedDigest}"`);
    expect(text).not.toMatch(/\d{4}\.\d{2}\.\d{2}\.\d+\+[0-9a-f]{7}/);
  });

  it("changes the digest when one input byte changes", () => {
    const { dir, expectedDigest } = stampFixture();
    writeFileSync(join(dir, "a.txt"), "alpha!\n");
    const out = join(dir, "build-stamp.ts");
    const result = runCli(
      [
        "stamp",
        "--sha",
        SHA_A,
        "--build-id",
        "1396224001-123456789-1",
        "--out",
        out,
        "--input",
        "a.txt",
        "--input",
        "dir/b.txt",
      ],
      { cwd: dir },
    );
    expect(result.status, result.stderr).toBe(0);
    const text = readFileSync(out, "utf8");
    expect(text).not.toContain(expectedDigest);
    expect(text).toContain(
      `inputSetDigest: "${sha256(`${sha256("alpha!\n")}  a.txt\n${sha256("beta")}  dir/b.txt\n`)}"`,
    );
  });

  it.each([
    [
      ["--sha", SHA_A.slice(0, 39), "--build-id", "1396224001-1-1", "--input", "a.txt"],
      "short SHA",
    ],
    [
      ["--sha", SHA_A.toUpperCase(), "--build-id", "1396224001-1-1", "--input", "a.txt"],
      "uppercase SHA",
    ],
    [["--sha", SHA_A, "--build-id", "123456789-1", "--input", "a.txt"], "two-group build ID"],
    [["--sha", SHA_A, "--build-id", "1396224001-1-1"], "no inputs"],
    [["--sha", SHA_A, "--build-id", "1396224001-1-1", "--input", "missing.txt"], "missing input"],
    [
      ["--sha", SHA_A, "--build-id", "1396224001-1-1", "--input", "../escape.txt"],
      "parent-escaping input",
    ],
    [
      ["--sha", SHA_A, "--build-id", "1396224001-1-1", "--input", "a.txt", "--input", "a.txt"],
      "duplicate input",
    ],
  ])("refuses stamp case %# without writing output", (extra, label) => {
    const { dir } = stampFixture();
    const out = join(dir, "build-stamp.ts");
    const result = runCli(["stamp", ...extra, "--out", out], { cwd: dir });
    expectRefusal(result, label as string);
    expect(existsSync(out), label as string).toBe(false);
  });

  it("refuses an absolute input path and never echoes input contents", () => {
    const { dir } = stampFixture();
    const out = join(dir, "build-stamp.ts");
    const result = runCli(
      [
        "stamp",
        "--sha",
        SHA_A,
        "--build-id",
        "1396224001-1-1",
        "--out",
        out,
        "--input",
        join(dir, "secret.txt"),
      ],
      { cwd: dir },
    );
    expectRefusal(result, "absolute input");
    expect(`${result.stdout}\n${result.stderr}`).not.toContain(CONTENT_SENTINEL);
  });
});

// --- Requirement 5: event-ID allocation --------------------------------
type Row = Record<string, unknown>;

function canonicalRow(
  n: number,
  over: { date?: string; sha?: string; createdAt?: string; id?: number } = {},
): Row {
  const sha = over.sha ?? SHA_A;
  const date = over.date ?? DATE;
  const eventId = `${date}.${n}+${sha.slice(0, 7)}`;
  return {
    id: over.id ?? 1000 + n,
    environment: "staging",
    sha,
    ref: sha,
    description: eventId,
    payload: { deploy_event_id: eventId },
    created_at: over.createdAt ?? "2026-10-27T10:00:00Z",
  };
}

function autoRow(over: Row = {}): Row {
  return {
    id: 9000,
    environment: "staging",
    sha: SHA_A,
    description: "",
    payload: {},
    created_at: "2026-10-27T09:00:00Z",
    ...over,
  };
}

function fixtureFile(rows: unknown): string {
  const file = join(tempDir(), "deployments.json");
  writeFileSync(file, typeof rows === "string" ? rows : JSON.stringify(rows));
  return file;
}

function nextArgs(rows: unknown, extra: string[] = []): string[] {
  return [
    "next",
    "--environment",
    "staging",
    "--sha",
    SHA_A,
    "--date",
    DATE,
    "--deployments-json",
    fixtureFile(rows),
    ...extra,
  ];
}

describe("deploy-identity next (fixture enumeration)", () => {
  it("mints N=1 for a day with no canonical records", () => {
    const result = runCli(nextArgs([]));
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(`DEPLOY_EVENT_ID=${DATE}.1+0123456\n`);
  });

  it("counts only canonical same-day records, ignoring automatic and older rows", () => {
    const rows = [
      canonicalRow(2, { id: 12 }),
      autoRow({ id: 11 }),
      canonicalRow(1, { id: 10 }),
      canonicalRow(7, { date: "2026.10.26", createdAt: "2026-10-26T23:00:00Z", id: 9 }),
      autoRow({ id: 8, description: null, payload: "", created_at: "2026-10-27T08:00:00Z" }),
    ];
    const result = runCli(nextArgs(rows));
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(`DEPLOY_EVENT_ID=${DATE}.3+0123456\n`);
  });

  it("dates rows by their UTC calendar date, not their local offset", () => {
    const rows = [
      // 2026-10-26 22:30 UTC: yesterday, never counted for the 27th.
      canonicalRow(5, { date: "2026.10.26", createdAt: "2026-10-27T01:30:00+03:00", id: 20 }),
      // 2026-10-27 01:30 UTC: today, counted.
      canonicalRow(1, { createdAt: "2026-10-26T23:30:00-02:00", id: 21 }),
    ];
    const result = runCli(nextArgs(rows));
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(`DEPLOY_EVENT_ID=${DATE}.2+0123456\n`);
  });

  it("keeps staging and production counters independent", () => {
    const staging = runCli(nextArgs([canonicalRow(1), canonicalRow(2, { id: 1002 })]));
    expect(staging.stdout).toBe(`DEPLOY_EVENT_ID=${DATE}.3+0123456\n`);
    const production = runCli([
      "next",
      "--environment",
      "production",
      "--sha",
      SHA_A,
      "--date",
      DATE,
      "--deployments-json",
      fixtureFile([]),
    ]);
    expect(production.status, production.stderr).toBe(0);
    expect(production.stdout).toBe(`DEPLOY_EVENT_ID=${DATE}.1+0123456\n`);
  });

  it("defaults to today's UTC date when --date is omitted", () => {
    const before = new Date().toISOString().slice(0, 10).replaceAll("-", ".");
    const result = runCli([
      "next",
      "--environment",
      "staging",
      "--sha",
      SHA_A,
      "--deployments-json",
      fixtureFile([]),
    ]);
    const after = new Date().toISOString().slice(0, 10).replaceAll("-", ".");
    expect(result.status, result.stderr).toBe(0);
    expect([
      `DEPLOY_EVENT_ID=${before}.1+0123456\n`,
      `DEPLOY_EVENT_ID=${after}.1+0123456\n`,
    ]).toContain(result.stdout);
  });

  it.each([
    [[autoRow({ created_at: undefined })], "row without created_at"],
    [[autoRow({ created_at: "2026-10-27T10:00:00" })], "naive created_at"],
    [[autoRow({ created_at: "not-a-timestamp" })], "garbage created_at"],
    [["not-an-object"], "non-object row"],
    [
      [{ ...canonicalRow(1), payload: { deploy_event_id: `${DATE}.2+0123456` } }],
      "payload event ID disagrees with description",
    ],
    [
      [autoRow({ description: `${DATE}.01+0123456`, payload: {} })],
      "claimed but noncanonical event ID (leading zero)",
    ],
    [
      [autoRow({ description: "2026.02.30.1+0123456", payload: {} })],
      "claimed but noncanonical event ID (impossible date)",
    ],
  ])("fails closed on malformed enumeration case %#", (rows, label) => {
    expectRefusal(runCli(nextArgs(rows)), label as string);
  });

  it("fails closed past the 600-row same-day bound instead of minting a duplicate", () => {
    const rows = Array.from({ length: 601 }, (_, i) => canonicalRow(i + 1, { id: 2000 + i }));
    expectRefusal(runCli(nextArgs(rows)), "unsafe counter bound");
  });

  it.each([
    [["--environment", "qa", "--sha", SHA_A, "--date", DATE], "unknown environment"],
    [["--environment", "Staging", "--sha", SHA_A, "--date", DATE], "capitalised environment"],
    [["--environment", "staging", "--sha", "abc", "--date", DATE], "bad SHA"],
    [["--environment", "staging", "--sha", SHA_A, "--date", "2026.02.30"], "impossible date"],
    [["--environment", "staging", "--sha", SHA_A, "--date", "2026-10-27"], "wrong date spelling"],
  ])("refuses allocation arguments case %#", (args, label) => {
    const result = runCli(["next", ...args, "--deployments-json", fixtureFile([])]);
    expectRefusal(result, label as string);
  });

  it("fails closed on an unreadable or non-array fixture", () => {
    expectRefusal(runCli(nextArgs("{not json")), "invalid JSON fixture");
    expectRefusal(runCli(nextArgs({ rows: [] })), "non-array fixture");
    expectRefusal(
      runCli([
        "next",
        "--environment",
        "staging",
        "--sha",
        SHA_A,
        "--date",
        DATE,
        "--deployments-json",
        join(tempDir(), "absent.json"),
      ]),
      "missing fixture file",
    );
  });
});

describe("deploy-identity next saved-record reuse", () => {
  it("writes the saved record once and reuses it on retry without reallocating", () => {
    const dir = tempDir();
    const saved = join(dir, "saved-event-id.txt");
    const first = runCli([
      "next",
      "--environment",
      "staging",
      "--sha",
      SHA_A,
      "--date",
      DATE,
      "--deployments-json",
      fixtureFile([]),
      "--saved",
      saved,
    ]);
    expect(first.status, first.stderr).toBe(0);
    expect(first.stdout).toBe(`DEPLOY_EVENT_ID=${DATE}.1+0123456\n`);
    expect(readFileSync(saved, "utf8").trim()).toBe(`${DATE}.1+0123456`);
    // The record now exists in the enumeration; a fresh allocation
    // would mint N=2, but the same attempt must reuse its saved ID.
    const retry = runCli([
      "next",
      "--environment",
      "staging",
      "--sha",
      SHA_A,
      "--date",
      DATE,
      "--deployments-json",
      fixtureFile([canonicalRow(1)]),
      "--saved",
      saved,
    ]);
    expect(retry.status, retry.stderr).toBe(0);
    expect(retry.stdout).toBe(`DEPLOY_EVENT_ID=${DATE}.1+0123456\n`);
  });

  it("reuses a saved record across a UTC date change for the same attempt", () => {
    const dir = tempDir();
    const saved = join(dir, "saved.txt");
    writeFileSync(saved, "2026.10.26.4+0123456\n");
    const result = runCli([
      "next",
      "--environment",
      "staging",
      "--sha",
      SHA_A,
      "--date",
      DATE,
      "--deployments-json",
      fixtureFile([]),
      "--saved",
      saved,
    ]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("DEPLOY_EVENT_ID=2026.10.26.4+0123456\n");
  });

  it.each([
    ["hello\n", "malformed saved record"],
    [`${DATE}.1+fedcba9\n`, "saved record for another commit"],
    ["", "empty saved record"],
  ])("refuses instead of reallocating over saved case %#", (content, label) => {
    const dir = tempDir();
    const saved = join(dir, "saved.txt");
    writeFileSync(saved, content as string);
    const result = runCli([
      "next",
      "--environment",
      "staging",
      "--sha",
      SHA_A,
      "--date",
      DATE,
      "--deployments-json",
      fixtureFile([]),
      "--saved",
      saved,
    ]);
    expectRefusal(result, label as string);
    expect(readFileSync(saved, "utf8")).toBe(content as string);
  });
});

describe("deploy-identity next (live bounded pagination)", () => {
  const liveEnv = { GITHUB_REPOSITORY: "o/r", GITHUB_TOKEN: TOKEN_SENTINEL };
  const liveArgs = ["next", "--environment", "staging", "--sha", SHA_A, "--date", DATE];

  it("walks pages newest-first and stops at the first older row", () => {
    const page1 = [
      canonicalRow(2, { id: 3002 }),
      canonicalRow(1, { id: 3001 }),
      ...Array.from({ length: 98 }, (_, i) => autoRow({ id: 4000 + i })),
    ];
    // The page=2 entry comes first: "per_page=100" itself contains the
    // substring "page=1", so a page=1 entry would swallow page 2.
    const stub = [
      {
        match: "page=2",
        body: [canonicalRow(9, { date: "2026.10.26", createdAt: "2026-10-26T12:00:00Z" })],
      },
      { match: "page=1", body: page1 },
    ];
    const result = runCli(liveArgs, { env: liveEnv, stub });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(`DEPLOY_EVENT_ID=${DATE}.3+0123456\n`);
    expect(result.stderr).not.toContain(TOKEN_SENTINEL);
  });

  it("fails closed when six full pages never reach an older row", () => {
    const full = Array.from({ length: 100 }, (_, i) => autoRow({ id: 5000 + i }));
    // Descending order for the same per_page substring reason as above.
    const stub = Array.from({ length: 6 }, (_, p) => ({ match: `page=${6 - p}`, body: full }));
    expectRefusal(runCli(liveArgs, { env: liveEnv, stub }), "incomplete pagination");
  });

  it.each([
    [[{ match: "deployments", status: 500, body: { message: "upstream-SENTINEL" } }], "HTTP 500"],
    [[{ match: "deployments", fail: true }], "transport failure"],
    [[{ match: "deployments", body: { message: "not an array" } }], "non-array page"],
  ])("fails closed on live enumeration case %#", (stub, label) => {
    const result = runCli(liveArgs, { env: liveEnv, stub: stub as StubEntry[] });
    expectRefusal(result, label as string);
    expect(`${result.stdout}\n${result.stderr}`).not.toContain(TOKEN_SENTINEL);
    expect(`${result.stdout}\n${result.stderr}`).not.toContain("upstream-SENTINEL");
  });

  it("fails closed in live mode without GITHUB_REPOSITORY", () => {
    const result = runCli(liveArgs, { env: { GITHUB_TOKEN: TOKEN_SENTINEL }, stub: [] });
    expectRefusal(result, "missing repository");
  });
});

// --- Requirement 6: canonical Deployment records ------------------------
describe("deploy-identity create/status request shapes (dry-run)", () => {
  const createArgs = ["--environment", "production", "--sha", SHA_A, "--deploy-event-id", EVENT_N3];

  it("builds the exact production create request", () => {
    const result = runCli(["create", ...createArgs, "--dry-run"]);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      create: {
        ref: SHA_A,
        task: "deploy",
        environment: "production",
        production_environment: true,
        auto_merge: false,
        required_contexts: [],
        description: EVENT_N3,
        payload: { deploy_event_id: EVENT_N3 },
      },
    });
  });

  it("marks staging as a non-production environment and flags rollbacks", () => {
    const staging = runCli([
      "create",
      "--environment",
      "staging",
      "--sha",
      SHA_A,
      "--deploy-event-id",
      EVENT_N3,
      "--dry-run",
    ]);
    expect(staging.status, staging.stderr).toBe(0);
    expect(JSON.parse(staging.stdout).create.production_environment).toBe(false);
    const rollback = runCli(["create", ...createArgs, "--rollback", "--dry-run"]);
    expect(rollback.status, rollback.stderr).toBe(0);
    expect(JSON.parse(rollback.stdout).create.payload).toEqual({
      deploy_event_id: EVENT_N3,
      rollback: true,
    });
  });

  it("builds the exact status request, with URL keys only when passed", () => {
    const bare = runCli([
      "status",
      "--deployment-id",
      "7236504973",
      "--deploy-event-id",
      EVENT_N3,
      "--state",
      "success",
      "--dry-run",
    ]);
    expect(bare.status, bare.stderr).toBe(0);
    expect(JSON.parse(bare.stdout)).toEqual({
      status: { state: "success", description: EVENT_N3 },
    });
    const withUrls = runCli([
      "status",
      "--deployment-id",
      "7236504973",
      "--deploy-event-id",
      EVENT_N3,
      "--state",
      "failure",
      "--run-url",
      "https://example.test/runs/1",
      "--environment-url",
      "https://example.test/",
      "--dry-run",
    ]);
    expect(withUrls.status, withUrls.stderr).toBe(0);
    expect(JSON.parse(withUrls.stdout)).toEqual({
      status: {
        state: "failure",
        description: EVENT_N3,
        log_url: "https://example.test/runs/1",
        environment_url: "https://example.test/",
      },
    });
  });

  it.each([
    [
      ["create", "--environment", "qa", "--sha", SHA_A, "--deploy-event-id", EVENT_N3],
      "unknown environment",
    ],
    [
      ["create", "--environment", "staging", "--sha", "abc", "--deploy-event-id", EVENT_N3],
      "bad SHA",
    ],
    [
      ["create", "--environment", "staging", "--sha", SHA_A, "--deploy-event-id", "nope"],
      "noncanonical event ID",
    ],
    [
      ["create", "--environment", "staging", "--sha", SHA_B, "--deploy-event-id", EVENT_N3],
      "event ID suffix names another commit",
    ],
    [
      ["status", "--deployment-id", "0", "--deploy-event-id", EVENT_N3, "--state", "success"],
      "zero Deployment ID",
    ],
    [
      ["status", "--deployment-id", "abc", "--deploy-event-id", EVENT_N3, "--state", "success"],
      "non-numeric Deployment ID",
    ],
    [
      ["status", "--deployment-id", "7", "--deploy-event-id", EVENT_N3, "--state", "in_progress"],
      "non-final status state",
    ],
    [
      [
        "status",
        "--deployment-id",
        "7",
        "--deploy-event-id",
        EVENT_N3,
        "--state",
        "success",
        "--run-url",
        "http://example.test/run",
      ],
      "non-https run URL",
    ],
    [
      [
        "status",
        "--deployment-id",
        "7",
        "--deploy-event-id",
        EVENT_N3,
        "--state",
        "success",
        "--run-url",
        "https://user:pass@example.test/run",
      ],
      "credential-bearing run URL",
    ],
  ])("refuses record arguments case %# even in dry-run", (args, label) => {
    expectRefusal(runCli([...args, "--dry-run"]), label as string);
  });
});

describe("deploy-identity create/status (live, stubbed GitHub API)", () => {
  const liveEnv = { GITHUB_REPOSITORY: "o/r", GITHUB_TOKEN: TOKEN_SENTINEL };
  const createLive = [
    "create",
    "--environment",
    "staging",
    "--sha",
    SHA_A,
    "--deploy-event-id",
    EVENT_N3,
  ];

  it("creates the Deployment and prints its numeric ID", () => {
    const stub = [
      { match: "environment=", body: [] },
      { match: "repos/o/r/deployments", status: 201, body: { id: 7236504973 } },
    ];
    const result = runCli(createLive, { env: liveEnv, stub });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("GITHUB_DEPLOYMENT_ID=7236504973");
    expect(result.stderr).not.toContain(TOKEN_SENTINEL);
  });

  it("reuses an existing canonical record instead of creating a duplicate", () => {
    const stub = [
      { match: "environment=", body: [canonicalRow(3, { id: 555 })] },
      // Any create attempt fails the transport, proving none was made.
      { match: "repos/o/r/deployments", fail: true },
    ];
    const result = runCli(createLive, { env: liveEnv, stub });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("GITHUB_DEPLOYMENT_ID=555");
  });

  it("refuses when the event ID is already bound to a different full SHA", () => {
    const otherFullSha = `${SHA_A.slice(0, 7)}${"0".repeat(33)}`;
    const stub = [
      { match: "environment=", body: [canonicalRow(3, { id: 555, sha: otherFullSha })] },
      { match: "repos/o/r/deployments", status: 201, body: { id: 999 } },
    ];
    expectRefusal(runCli(createLive, { env: liveEnv, stub }), "event ID collision");
  });

  it.each([
    [
      [
        { match: "environment=", body: [] },
        { match: "repos/o/r/deployments", status: 422, body: { message: "upstream-SENTINEL" } },
      ],
      "create HTTP failure",
    ],
    [
      [
        { match: "environment=", body: [] },
        { match: "repos/o/r/deployments", status: 201, body: { id: "7236504973" } },
      ],
      "non-integer Deployment ID in create response",
    ],
    [
      [
        { match: "environment=", body: [] },
        { match: "repos/o/r/deployments", status: 201, body: {} },
      ],
      "missing Deployment ID in create response",
    ],
  ])("fails closed on create case %# without echoing upstream", (stub, label) => {
    const result = runCli(createLive, { env: liveEnv, stub: stub as StubEntry[] });
    expectRefusal(result, label as string);
    expect(result.stdout).not.toContain("GITHUB_DEPLOYMENT_ID=");
    expect(`${result.stdout}\n${result.stderr}`).not.toContain(TOKEN_SENTINEL);
    expect(`${result.stdout}\n${result.stderr}`).not.toContain("upstream-SENTINEL");
  });

  it("posts a final status and fails when that post fails", () => {
    const statusArgs = [
      "status",
      "--deployment-id",
      "555",
      "--deploy-event-id",
      EVENT_N3,
      "--state",
      "success",
    ];
    const ok = runCli(statusArgs, {
      env: liveEnv,
      stub: [{ match: "/statuses", status: 201, body: {} }],
    });
    expect(ok.status, ok.stderr).toBe(0);
    const failed = runCli(statusArgs, {
      env: liveEnv,
      stub: [{ match: "/statuses", status: 500, body: { message: "upstream-SENTINEL" } }],
    });
    expectRefusal(failed, "status post failure");
    expect(`${failed.stdout}\n${failed.stderr}`).not.toContain("upstream-SENTINEL");
  });
});

// --- Requirements 1, 2, 6, 7: lane workflow wiring ----------------------
function stepRegion(text: string, needle: string): string {
  const at = text.indexOf(needle);
  expect(at, `workflow contains ${needle}`).toBeGreaterThanOrEqual(0);
  const rest = text.slice(at);
  const next = rest.indexOf("\n      - ", 1);
  return next === -1 ? rest : rest.slice(0, next);
}

function recordsFailureStatus(workflow: string): boolean {
  return workflow
    .split(/\n(?=\s*- name:)/)
    .some(
      (step) =>
        step.includes("deploy-identity.mjs status") &&
        ((step.includes("if: failure()") && step.includes("--state failure")) ||
          (step.includes("if: always()") && step.includes("failure"))),
    );
}

describe("lane workflow identity wiring", () => {
  it("staging: stamps before compiling, allocates and creates before deploy, records after proof", () => {
    const wf = read(".github/workflows/deploy.yml");
    const stamp = wf.indexOf("deploy-identity.mjs stamp");
    const build = wf.indexOf("npm run build --prefix web");
    const next = wf.indexOf("deploy-identity.mjs next");
    const create = wf.indexOf("deploy-identity.mjs create");
    const deploy = wf.indexOf("wrangler deploy --config web/wrangler.staging.jsonc");
    const proof = wf.lastIndexOf("bin/revision-check.mjs");
    const status = wf.indexOf("deploy-identity.mjs status", proof);
    for (const [label, at] of [
      ["stamp", stamp],
      ["next", next],
      ["create", create],
    ] as const) {
      expect(at, `staging ${label} step`).toBeGreaterThanOrEqual(0);
    }
    expect(stamp).toBeLessThan(build);
    expect(next).toBeLessThan(deploy);
    expect(create).toBeGreaterThan(next);
    expect(create).toBeLessThan(deploy);
    const deployStep = stepRegion(wf, "wrangler deploy --config web/wrangler.staging.jsonc");
    for (const name of ["DEPLOY_EVENT_ID:", "DEPLOYMENT_ENVIRONMENT:", "GITHUB_DEPLOYMENT_ID:"]) {
      expect(deployStep, `staging deploy passes ${name}`).toContain(name);
    }
    expect(status, "staging status after deployed-revision proof").toBeGreaterThan(proof);
    expect(recordsFailureStatus(wf), "staging records failure status").toBe(true);
    // Existing bare-SHA version tag is preserved (requirement 7 control).
    expect(wf).toContain('--tag "${DEPLOY_SHA:?}"');
  });

  it("production: stamps before compiling, allocates and creates before upload, records after proof", () => {
    const wf = read(".github/workflows/deploy-production.yml");
    const stamp = wf.indexOf("deploy-identity.mjs stamp");
    const dryRun = wf.indexOf("wrangler deploy --dry-run --env production");
    const next = wf.indexOf("deploy-identity.mjs next");
    const create = wf.indexOf("deploy-identity.mjs create");
    const upload = wf.indexOf("wrangler versions upload --env production");
    const proof = wf.indexOf("Verify public routes on the promoted version");
    const status = wf.indexOf("deploy-identity.mjs status", proof);
    for (const [label, at] of [
      ["stamp", stamp],
      ["next", next],
      ["create", create],
    ] as const) {
      expect(at, `production ${label} step`).toBeGreaterThanOrEqual(0);
    }
    expect(stamp).toBeLessThan(dryRun);
    expect(next).toBeLessThan(upload);
    expect(create).toBeGreaterThan(next);
    expect(create).toBeLessThan(upload);
    const uploadStep = stepRegion(wf, "wrangler versions upload --env production");
    for (const name of ["DEPLOY_EVENT_ID:", "DEPLOYMENT_ENVIRONMENT:", "GITHUB_DEPLOYMENT_ID:"]) {
      expect(uploadStep, `production upload passes ${name}`).toContain(name);
    }
    expect(status, "production status after promoted-route proof").toBeGreaterThan(proof);
    expect(recordsFailureStatus(wf), "production records failure status").toBe(true);
    // Existing composite version tag is preserved (requirement 7 control).
    expect(wf).toContain('--tag "${DEPLOY_SHA:?}-${GITHUB_RUN_ID:?}-${GITHUB_RUN_ATTEMPT:?}"');
  });

  it("recording never gates recovery: rollback restores before any identity recording", () => {
    const wf = read(".github/workflows/rollback-production.yml");
    const rollback = wf.indexOf("wrangler rollback");
    expect(rollback).toBeGreaterThanOrEqual(0);
    const identity = wf.indexOf("deploy-identity.mjs");
    if (identity !== -1) expect(identity).toBeGreaterThan(rollback);
  });

  it("keeps per-deploy IDs out of checked-in wrangler vars (control)", () => {
    for (const file of ["wrangler.jsonc", "web/wrangler.staging.jsonc"]) {
      const text = read(file);
      expect(text, file).not.toMatch(/"DEPLOY_EVENT_ID"\s*:/);
      expect(text, file).not.toMatch(/"GITHUB_DEPLOYMENT_ID"\s*:/);
    }
  });
});
