// Acceptance: erasure typed host confirmation (H2).
//
// Target: `bin/erase-member.mjs` requires `--confirm <host>` for
// staging/production `--apply` runs. Threat-model residual:
// `docs/threat-model.md` row on operator `--target` mistakes — the target
// is an operator assertion the tool cannot verify.
//
// CONTRACT FOR THE BUILDER (GREEN path; implement exactly this):
// - New code `E_CONFIRM` in `bin/operator-cli-errors.mjs` (exit 2) with
//   fixed message/next mentioning `--confirm` and `host`. Suggested:
//   message "Refusing: --apply with --target staging or --target production
//   requires --confirm <host>." next "Re-run with --confirm <host> where
//   <host> exactly matches the DATABASE_URL host." Exact wording is free
//   as long as these tests pass: single-line, non-empty, identical across
//   hosts/ids (no interpolation), redacted (no host/password/URL/id),
//   message matches /--confirm/, next matches /--confirm|host/.
// - `parseEraseArgs` accepts `--confirm <host>` and `--confirm=<host>`;
//   duplicate `--confirm` throws E_DUPLICATE_FLAG; missing, flag-like, or
//   empty value throws E_CONFIRM; returns a `confirm` field (undefined
//   when absent; `toEqual` ignores undefined so existing pins stay green).
// - Enforcement point: AFTER existing target/TLS validation, BEFORE any
//   `postgres()` call. When mode is `apply` AND a remote target
//   (`staging`|`production`) was accepted, require `confirm` to be
//   byte-identical to `new URL(DATABASE_URL).hostname`: no trim, no case
//   folding. Missing/mismatched/case-differing/whitespace-padded values
//   emit the coded E_CONFIRM JSON to stderr-only, exit 2.
//   Precedence (existing checks win): remote without `--target` is still
//   E_REMOTE_TARGET; `--target staging` on a production-looking URL is
//   still E_PRODUCTION_TARGET even with a correct `--confirm`.
// - Local hosts (`agent-testdb`, `localhost`, `127.0.0.1`, `::1` per the
//   existing allowlist) NEVER require `--confirm` in either mode; a
//   supplied `--confirm` (even wrong) is ignored locally.
// - Dry-run (default or explicit) NEVER refuses for `--confirm` and always
//   proceeds. Remote dry-run without `--confirm` adds a fixed-string
//   `confirmHint` field to the success stdout JSON mentioning `--confirm`
//   (redacted, identical across hosts). Local dry-run omits `confirmHint`.
// - `--help` exits 0 without config, mentions `--confirm <host>`, shows an
//   example invocation containing `--confirm` plus the word "example"
//   (any case), and lists `E_CONFIRM` via the shared error table.
// - Update `docs/member-erasure.md` code table (else the doc-table pin
//   test fails) and the usage section. Do NOT touch `revoke-sessions`,
//   `src/member-erasure.ts` logic, or these test files.
//
// RED expectation on the unpatched head: parser tests throw
// E_UNKNOWN_FLAG instead of E_CONFIRM/confirm; apply+remote without
// `--confirm` calls the driver instead of refusing; apply+remote with
// `--confirm` refuses E_UNKNOWN_FLAG instead of E_CONFIRM/success;
// remote dry-run succeeds without `confirmHint`; help lacks the flag;
// the OPERATOR_ERRORS pin misses E_CONFIRM; staging-on-prod WITH
// `--confirm` refuses E_UNKNOWN_FLAG instead of E_PRODUCTION_TARGET.
// Controls that PASS on RED (existing behavior, must stay green):
// local runs without the flag, staging-on-prod WITHOUT `--confirm`,
// missing-target precedence, parse-shape default, and local dry-run
// omitting the hint.
//
// Offline only: the postgres.js boundary is mocked (no sockets); the
// subprocess checks use `.invalid`/`.test` hosts and assert exit 2
// (refusal) so no connection is ever attempted. No live DB.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main as erase, parseEraseArgs } from "../bin/erase-member.mjs";
import { OPERATOR_ERRORS } from "../bin/operator-cli-errors.mjs";

const driver = vi.hoisted(() => ({ factory: vi.fn() }));
vi.mock("postgres", () => ({ default: driver.factory }));

const ID = "100000000000000201";
const OTHER_ID = "100000000000000202";
const SECRET = "synthetic-password";
const STAGING_HOST = "ep-staging.example.neon.tech.invalid";
const STAGING_URL = `postgres://fixture:${SECRET}@${STAGING_HOST}/neondb?sslmode=verify-full`;
const PROD_HOST = "db.production.test";
const PROD_URL = `postgres://fixture:${SECRET}@${PROD_HOST}/neondb?sslmode=verify-full`;
const OTHER_HOST = "db.other.invalid";
const LOCAL_URLS = [
  "postgres://agent_test@agent-testdb:5432/two_web_next",
  "postgres://fixture@localhost:5432/postgres",
  "postgres://fixture@127.0.0.1:5432/postgres",
  "postgres://fixture@[::1]:5432/postgres",
];
const COUNTS = {
  users: 1,
  profiles: 2,
  rsvps: 3,
  web_sessions: 4,
  web_session_grace: 5,
  join_attempts: 6,
  overlay_configs: 7,
  overlay_tokens: 8,
};
const ROW = "private-fixture-row";
const SCRIPT = fileURLToPath(new URL("../bin/erase-member.mjs", import.meta.url).href);
const ROOT = fileURLToPath(new URL("..", import.meta.url).href);

const run = (args = [], env = {}) =>
  spawnSync(process.execPath, ["--import", "./bin/ts-hook.mjs", SCRIPT, ...args], {
    env,
    cwd: ROOT,
    encoding: "utf8",
    timeout: 20_000,
  });

// Same boundary fixture shape as the coded-errors suite: the real
// eraseMember still chooses dry-run vs transaction; only postgres() is fake.
function fakeClient(failure) {
  const remaining = { ...COUNTS };
  const queries = [];
  const writes = [];
  const sql = async (strings, ...values) => {
    const text = strings.join("?").replace(/\s+/g, " ").trim();
    queries.push({ text, values });
    if (failure) throw failure;
    if (text === "select pg_advisory_xact_lock(hashtextextended('two:overlay:' || ?, 0))")
      return [];
    const table = text.match(/(?:from|update) (\w+)/i)?.[1];
    if (!(table in remaining)) throw new Error(`Unexpected fixture SQL: ${text}`);
    if (/^select count\(/i.test(text)) return [{ n: remaining[table] }];
    if (/^(delete|update) /i.test(text)) {
      writes.push({ text, values });
      const count = remaining[table];
      remaining[table] = 0;
      return Array.from({ length: count }, () => ({ "?column?": 1 }));
    }
    throw new Error(`Unexpected fixture SQL: ${text}`);
  };
  sql.begin = vi.fn(async (fn) => fn(sql));
  sql.end = vi.fn(async () => {});
  return { sql, queries, writes, remaining };
}

async function invoke(args, env) {
  let stdout = "";
  let stderr = "";
  const methods = ["log", "info", "warn", "error", "debug", "trace"];
  const originalConsole = Object.fromEntries(methods.map((key) => [key, console[key]]));
  const pgEnv = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key.startsWith("PG")),
  );
  const tls = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  const out = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdout += String(chunk);
    return true;
  });
  const err = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr += String(chunk);
    return true;
  });
  for (const key of methods) {
    console[key] = (...values) => {
      const line = `${values.join(" ")}\n`;
      if (key === "log" || key === "info") stdout += line;
      else stderr += line;
    };
  }
  try {
    return {
      status: await erase(args, env),
      get stdout() {
        return stdout;
      },
      get stderr() {
        return stderr;
      },
    };
  } finally {
    out.mockRestore();
    err.mockRestore();
    Object.assign(console, originalConsole);
    for (const key of Object.keys(process.env)) if (key.startsWith("PG")) delete process.env[key];
    Object.assign(process.env, pgEnv);
    if (tls === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = tls;
  }
}

function assertRedacted(text, extra = []) {
  for (const value of [
    STAGING_URL,
    PROD_URL,
    STAGING_HOST,
    PROD_HOST,
    OTHER_HOST,
    SECRET,
    ROW,
    ID,
    OTHER_ID,
    "postgres://",
    "localhost",
    ...extra,
  ])
    expect(text).not.toContain(value);
}

function confirmRefusal(result) {
  expect(result.status).toBe(2);
  expect(result.stdout).toBe("");
  expect(driver.factory).not.toHaveBeenCalled();
  assertRedacted(result.stderr);
  expect(result.stderr).toMatch(/^\{[^\r\n]*\}\n$/);
  const body = JSON.parse(result.stderr);
  expect(Object.keys(body).sort()).toEqual(["code", "message", "next", "ok"]);
  expect(body.ok).toBe(false);
  expect(body.code).toBe("E_CONFIRM");
  for (const field of ["message", "next"]) {
    expect(typeof body[field]).toBe("string");
    expect(body[field].trim().length).toBeGreaterThan(0);
    expect(body[field]).not.toMatch(/[\r\n]/);
  }
  expect(body.message).toMatch(/--confirm/);
  expect(body.next).toMatch(/--confirm|host/);
  return body;
}

afterEach(() => driver.factory.mockReset());

describe("erase-member --confirm parser", () => {
  it("accepts space and equals forms and returns the confirm value", () => {
    expect(
      parseEraseArgs([
        `--discord-id=${ID}`,
        "--apply",
        "--target",
        "staging",
        "--confirm",
        STAGING_HOST,
      ]),
    ).toMatchObject({ mode: "apply", target: "staging", confirm: STAGING_HOST });
    expect(
      parseEraseArgs([
        `--discord-id=${ID}`,
        "--apply",
        "--target=staging",
        `--confirm=${STAGING_HOST}`,
      ]),
    ).toMatchObject({ confirm: STAGING_HOST });
  });

  it("defaults confirm to undefined and keeps existing parse shape", () => {
    expect(parseEraseArgs([`--discord-id=${ID}`])).toEqual({
      discordId: ID,
      mode: "dry-run",
      target: undefined,
    });
    expect(parseEraseArgs([`--discord-id=${ID}`, "--apply"]).confirm).toBeUndefined();
  });

  it("refuses a repeated --confirm as a duplicate flag", () => {
    expect(() =>
      parseEraseArgs([
        `--discord-id=${ID}`,
        "--apply",
        "--target",
        "staging",
        "--confirm",
        STAGING_HOST,
        `--confirm=${STAGING_HOST}`,
      ]),
    ).toThrow(expect.objectContaining({ code: "E_DUPLICATE_FLAG" }));
  });

  for (const args of [
    [`--discord-id=${ID}`, "--apply", "--target", "staging", "--confirm"],
    [`--discord-id=${ID}`, "--apply", "--target", "staging", "--confirm", "--apply"],
    [`--discord-id=${ID}`, "--apply", "--target", "staging", "--confirm="],
  ]) {
    it(`refuses a malformed --confirm with E_CONFIRM: ${JSON.stringify(args.slice(-2))}`, () => {
      expect(() => parseEraseArgs(args)).toThrow(expect.objectContaining({ code: "E_CONFIRM" }));
    });
  }
});

describe("erase-member --confirm refusals (no socket)", () => {
  it("refuses apply+staging without --confirm before any connection", async () => {
    driver.factory.mockReturnValue(fakeClient().sql);
    const result = await invoke([`--discord-id=${ID}`, "--apply", "--target", "staging"], {
      DATABASE_URL: STAGING_URL,
    });
    confirmRefusal(result);
  });

  it("refuses a mismatched --confirm before any connection", async () => {
    driver.factory.mockReturnValue(fakeClient().sql);
    const result = await invoke(
      [`--discord-id=${ID}`, "--apply", "--target", "staging", "--confirm", OTHER_HOST],
      { DATABASE_URL: STAGING_URL },
    );
    confirmRefusal(result);
  });

  it("refuses a case-differing --confirm without folding", async () => {
    driver.factory.mockReturnValue(fakeClient().sql);
    const result = await invoke(
      [
        `--discord-id=${ID}`,
        "--apply",
        "--target",
        "staging",
        "--confirm",
        STAGING_HOST.toUpperCase(),
      ],
      { DATABASE_URL: STAGING_URL },
    );
    const body = confirmRefusal(result);
    expect(STAGING_HOST.toUpperCase()).not.toBe(STAGING_HOST);
    expect(body.code).toBe("E_CONFIRM");
  });

  for (const padded of [` ${STAGING_HOST}`, `${STAGING_HOST} `, `\t${STAGING_HOST}\n`]) {
    it(`refuses a whitespace-padded --confirm without trimming: ${JSON.stringify(padded)}`, async () => {
      driver.factory.mockReturnValue(fakeClient().sql);
      const result = await invoke(
        [`--discord-id=${ID}`, "--apply", "--target", "staging", "--confirm", padded],
        { DATABASE_URL: STAGING_URL },
      );
      confirmRefusal(result);
    });
  }

  it("refuses apply+production without --confirm (target correct, confirm missing)", async () => {
    driver.factory.mockReturnValue(fakeClient().sql);
    const result = await invoke([`--discord-id=${ID}`, "--apply", "--target", "production"], {
      DATABASE_URL: PROD_URL,
    });
    confirmRefusal(result);
  });

  it("emits fixed strings: identical message/next across hosts and ids", async () => {
    driver.factory.mockReturnValue(fakeClient().sql);
    const first = await invoke([`--discord-id=${ID}`, "--apply", "--target", "staging"], {
      DATABASE_URL: STAGING_URL,
    });
    const second = await invoke(
      [`--discord-id=${OTHER_ID}`, "--apply", "--target", "production", "--confirm", OTHER_HOST],
      { DATABASE_URL: PROD_URL },
    );
    const a = confirmRefusal(first);
    const b = confirmRefusal(second);
    expect(b.message).toBe(a.message);
    expect(b.next).toBe(a.next);
  });

  it("pins the E_CONFIRM coded error with exit 2", () => {
    expect(OPERATOR_ERRORS.E_CONFIRM).toMatchObject({ exitCode: 2 });
    expect(OPERATOR_ERRORS.E_CONFIRM.message).toMatch(/--confirm/);
    expect(String(OPERATOR_ERRORS.E_CONFIRM.next)).toMatch(/--confirm|host/);
  });
});

describe("erase-member --confirm precedence controls (existing behavior)", () => {
  it("staging on a production-looking URL is still E_PRODUCTION_TARGET without --confirm (control)", async () => {
    driver.factory.mockReturnValue(fakeClient().sql);
    const result = await invoke([`--discord-id=${ID}`, "--apply", "--target", "staging"], {
      DATABASE_URL: PROD_URL,
    });
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stderr).code).toBe("E_PRODUCTION_TARGET");
  });

  it("staging on a production-looking URL is still E_PRODUCTION_TARGET with a correct --confirm", async () => {
    driver.factory.mockReturnValue(fakeClient().sql);
    const result = await invoke(
      [`--discord-id=${ID}`, "--apply", "--target", "staging", "--confirm", PROD_HOST],
      { DATABASE_URL: PROD_URL },
    );
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(driver.factory).not.toHaveBeenCalled();
    expect(JSON.parse(result.stderr).code).toBe("E_PRODUCTION_TARGET");
  });

  it("remote without --target is still E_REMOTE_TARGET, not E_CONFIRM", async () => {
    driver.factory.mockReturnValue(fakeClient().sql);
    const result = await invoke([`--discord-id=${ID}`, "--apply"], {
      DATABASE_URL: STAGING_URL,
    });
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stderr).code).toBe("E_REMOTE_TARGET");
  });
});

describe("erase-member --confirm success paths", () => {
  it("apply+staging with the exact host proceeds to the existing flow", async () => {
    const fixture = fakeClient();
    driver.factory.mockReturnValue(fixture.sql);
    const result = await invoke(
      [`--discord-id=${ID}`, "--apply", "--target", "staging", "--confirm", STAGING_HOST],
      { DATABASE_URL: STAGING_URL },
    );
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toMatch(/^\{[^\r\n]*\}\n$/);
    const body = JSON.parse(result.stdout);
    expect(body).toMatchObject({
      ok: true,
      mode: "apply",
      counts: COUNTS,
      passes: 1,
      deletesPerPass: [4],
    });
    expect(fixture.queries.length).toBeGreaterThan(0);
    expect(fixture.sql.begin).toHaveBeenCalledTimes(1);
    expect(fixture.writes.length).toBeGreaterThan(0);
    expect(fixture.sql.end).toHaveBeenCalledTimes(1);
    assertRedacted(result.stdout);
  });

  it("apply+production with the exact host proceeds", async () => {
    const fixture = fakeClient();
    driver.factory.mockReturnValue(fixture.sql);
    const result = await invoke(
      [`--discord-id=${ID}`, "--apply", "--target", "production", "--confirm", PROD_HOST],
      { DATABASE_URL: PROD_URL },
    );
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, mode: "apply" });
    expect(fixture.sql.begin).toHaveBeenCalledTimes(1);
  });

  for (const local of LOCAL_URLS) {
    it(`local apply runs without --confirm: ${new URL(local.replace("[::1]", "127.0.0.1")).hostname}`, async () => {
      const fixture = fakeClient();
      driver.factory.mockReturnValue(fixture.sql);
      const result = await invoke([`--discord-id=${ID}`, "--apply"], { DATABASE_URL: local });
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, mode: "apply" });
      expect(fixture.sql.begin).toHaveBeenCalledTimes(1);
    });
  }

  it("local apply ignores a mismatched --confirm", async () => {
    const fixture = fakeClient();
    driver.factory.mockReturnValue(fixture.sql);
    const result = await invoke([`--discord-id=${ID}`, "--apply", "--confirm", OTHER_HOST], {
      DATABASE_URL: LOCAL_URLS[0],
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, mode: "apply" });
  });
});

describe("erase-member dry-run shows the requirement without enforcing", () => {
  for (const mode of [[], ["--dry-run"]]) {
    it(`remote ${mode.length ? "explicit" : "default"} dry-run without --confirm succeeds with a hint`, async () => {
      const fixture = fakeClient();
      driver.factory.mockReturnValue(fixture.sql);
      const result = await invoke([`--discord-id=${ID}`, ...mode, "--target", "staging"], {
        DATABASE_URL: STAGING_URL,
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toMatch(/^\{[^\r\n]*\}\n$/);
      const body = JSON.parse(result.stdout);
      expect(body).toMatchObject({ ok: true, mode: "dry-run", counts: COUNTS });
      expect(typeof body.confirmHint).toBe("string");
      expect(body.confirmHint).toMatch(/--confirm/);
      expect(body.confirmHint).not.toMatch(/[\r\n]/);
      assertRedacted(body.confirmHint);
      expect(fixture.sql.begin).not.toHaveBeenCalled();
      expect(fixture.writes).toEqual([]);
    });
  }

  it("remote dry-run with a mismatched --confirm still succeeds (not enforced)", async () => {
    const fixture = fakeClient();
    driver.factory.mockReturnValue(fixture.sql);
    const result = await invoke(
      [`--discord-id=${ID}`, "--dry-run", "--target", "staging", "--confirm", OTHER_HOST],
      { DATABASE_URL: STAGING_URL },
    );
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, mode: "dry-run" });
  });

  it("dry-run hint is a fixed string across hosts", async () => {
    driver.factory.mockReturnValue(fakeClient().sql);
    const first = await invoke([`--discord-id=${ID}`, "--target", "staging"], {
      DATABASE_URL: STAGING_URL,
    });
    const second = await invoke([`--discord-id=${OTHER_ID}`, "--target", "production"], {
      DATABASE_URL: PROD_URL,
    });
    const firstHint = JSON.parse(first.stdout).confirmHint;
    const secondHint = JSON.parse(second.stdout).confirmHint;
    expect(typeof firstHint).toBe("string");
    expect(typeof secondHint).toBe("string");
    expect(secondHint).toBe(firstHint);
  });

  it("local dry-run omits the hint", async () => {
    driver.factory.mockReturnValue(fakeClient().sql);
    const result = await invoke([`--discord-id=${ID}`], { DATABASE_URL: LOCAL_URLS[0] });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).not.toHaveProperty("confirmHint");
  });
});

describe("erase-member --help documents --confirm", () => {
  it("help mentions the flag, an example, and E_CONFIRM without config", async () => {
    const result = await invoke(["--help"], {});
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(driver.factory).not.toHaveBeenCalled();
    expect(result.stdout).toContain("Usage:");
    expect(result.stdout).toContain("--confirm");
    expect(result.stdout).toContain("<host>");
    expect(result.stdout).toMatch(/example/i);
    expect(result.stdout).toMatch(/--confirm\s+\S+/);
    expect(result.stdout).toContain("E_CONFIRM");
  });
});

describe("erase-member --confirm subprocess refusals (exit 2, no socket)", () => {
  it("subprocess refuses missing --confirm with exit 2 and redacted JSON", () => {
    const result = run([`--discord-id=${ID}`, "--apply", "--target", "staging"], {
      DATABASE_URL: STAGING_URL,
    });
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/^\{[^\r\n]*\}\n$/);
    const body = JSON.parse(result.stderr);
    expect(body).toMatchObject({ ok: false, code: "E_CONFIRM" });
    expect(body.message).toMatch(/--confirm/);
    const output = result.stdout + result.stderr;
    for (const secret of [STAGING_URL, STAGING_HOST, SECRET, ID, "postgres://"])
      expect(output).not.toContain(secret);
  });

  it("subprocess refuses mismatched, case-differing, and padded values with exit 2", () => {
    for (const confirm of [OTHER_HOST, STAGING_HOST.toUpperCase(), ` ${STAGING_HOST}`]) {
      const result = run(
        [`--discord-id=${ID}`, "--apply", "--target", "staging", "--confirm", confirm],
        { DATABASE_URL: STAGING_URL },
      );
      expect(result.status, confirm).toBe(2);
      expect(JSON.parse(result.stderr).code, confirm).toBe("E_CONFIRM");
    }
  });
});
