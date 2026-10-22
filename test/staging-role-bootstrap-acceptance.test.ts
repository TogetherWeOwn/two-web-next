// Test-Author-owned acceptance contract for the fixed-purpose staging web
// role bootstrap. The Builder implements production code, never these
// expectations. Spec: a manual, staging-Environment-only bootstrap that
// ensures the fixed NOLOGIN application role exists before overlay GRANTs
// can apply; reviewed main only, no caller-controlled SQL/role/database.
//
// Pinned Builder contract — ci/staging-role-bootstrap.mjs must export:
//   SECRET_NAME = "PLANETSCALE_STAGING_DATABASE_URL"
//   ROLE_NAME = "two_web_app"
//   CREATE_ROLE_DDL = "CREATE ROLE two_web_app NOLOGIN" (exact constant, no
//     semicolon; the ONLY DDL the bootstrap may ever emit)
//   ROLE_STATUS_QUERY: constant single SELECT against pg_roles for the fixed
//     role, returning at least rolname, rolcanlogin, rolsuper, rolcreatedb,
//     rolcreaterole, rolreplication, rolbypassrls, rolconnlimit,
//     has_memberships (EXISTS over pg_auth_members for the fixed role)
//   STATEMENT_TIMEOUT_MS: positive int, at most 60000
//   LOCK_TIMEOUT_MS: positive int, at most 30000
//   CONNECT_TIMEOUT_SECONDS: positive int, at most 30
//   validateStagingUrl(raw): URL for the pinned staging endpoint only (same
//     host/branch pins as ci/db-migrate.mjs, direct endpoint, TLS); throws
//     fail-closed otherwise; messages withhold values
//   assertBootstrapDdl(sql): true only for byte-exact CREATE_ROLE_DDL
//   classifyRole(row | null | undefined):
//     { state: "absent" } | { state: "compatible" } |
//     { state: "incompatible", reason: <names the attribute> }
//     Compatible = NOLOGIN with PostgreSQL CREATE ROLE defaults (no
//     superuser/createdb/createrole/replication/bypassrls and no role
//     memberships; passwords are not classified because pg_roles always
//     masks rolpassword). A missing membership signal is refused as
//     incompatible-unknown, never assumed absent.
//     See https://www.postgresql.org/docs/current/sql-createrole.html
//   bootstrapRole(client): client with unsafe(sql) like postgres.js;
//     check-first; absent -> emit CREATE_ROLE_DDL once, re-read, verify;
//     present+compatible -> no DDL; incompatible -> refuse without DDL;
//     duplicate-object race (code 42710) -> re-read, resolve present;
//     returns { outcome: "created" | "present", role, ddlIssued } with no
//     secret/URL material; errors withhold values
//   safeBootstrapError(error): allowlisted refusal messages pass through;
//     everything else becomes a generic withheld message
//   buildClientOptions(url): pinned client wiring (port 5432, max 1,
//     connect/statement/lock timeouts from the exported constants, TLS with
//     rejectUnauthorized, password decoded from the URL)
//   runBootstrap(env?, deps?): wires secret -> validate -> connect via
//     buildClientOptions -> bootstrapRole -> evidence JSON { outcome, role,
//     ddlIssued }; refusal-before-connect (a missing secret or an invalid
//     endpoint never opens a connection); deps.createClient is a test seam
//     only. CLI: no args runs, --selftest is DB-free PASS, other args are
//     usage errors (exit 2)
// Plus: .github/workflows/staging-role-bootstrap.yml — workflow_dispatch
// with no inputs, literal `environment: staging`, main-only ref gate before
// install, the EXISTING staging secret consumed in place only, no
// production input, single script invocation, no inline SQL. GitHub
// Environments scoping: https://docs.github.com/en/actions/managing-workflow-runs-and-deployments/managing-deployments/managing-environments-for-deployment
//
// All tests are offline and synthetic: injected fake clients, synthetic
// URLs built from the live infrastructure pins, no live database, no
// network, no workflow dispatch, no secret or environment changes.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error Standalone CI tooling has no declaration file.
import * as dbMigratePins from "../ci/db-migrate.mjs";

const {
  PLANETSCALE_PRODUCTION_BRANCH_ID,
  PLANETSCALE_PRODUCTION_HOST,
  PLANETSCALE_STAGING_BRANCH_ID,
  PLANETSCALE_STAGING_HOST,
} = dbMigratePins as {
  PLANETSCALE_PRODUCTION_BRANCH_ID: string;
  PLANETSCALE_PRODUCTION_HOST: string;
  PLANETSCALE_STAGING_BRANCH_ID: string;
  PLANETSCALE_STAGING_HOST: string;
};

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOW_PATH = resolve(repoRoot, ".github/workflows/staging-role-bootstrap.yml");

interface RoleRow {
  rolname: string;
  rolcanlogin: boolean;
  rolsuper: boolean;
  rolcreatedb: boolean;
  rolcreaterole: boolean;
  rolinherit: boolean;
  rolreplication: boolean;
  rolbypassrls: boolean;
  rolconnlimit: number;
  has_memberships: boolean;
}

interface FakeBootstrapClient {
  unsafe(sql: string): Promise<Record<string, unknown>[]>;
  end(): Promise<void>;
}

interface ClientOptions {
  port: number;
  max: number;
  connect_timeout: number;
  password(): string;
  ssl: { rejectUnauthorized: boolean };
  connection: { statement_timeout: number; lock_timeout: number };
}

interface BootstrapModule {
  SECRET_NAME: string;
  ROLE_NAME: string;
  CREATE_ROLE_DDL: string;
  ROLE_STATUS_QUERY: string;
  STATEMENT_TIMEOUT_MS: number;
  LOCK_TIMEOUT_MS: number;
  CONNECT_TIMEOUT_SECONDS: number;
  validateStagingUrl(raw: string): URL;
  assertBootstrapDdl(sql: string): true;
  classifyRole(row: RoleRow | null | undefined): {
    state: "absent" | "compatible" | "incompatible";
    reason?: string;
  };
  bootstrapRole(client: {
    unsafe(sql: string): Promise<Record<string, unknown>[]>;
  }): Promise<{ outcome: "created" | "present"; role: string; ddlIssued: boolean }>;
  safeBootstrapError(error: unknown): string;
  buildClientOptions(url: URL): ClientOptions;
  runBootstrap(
    env?: Record<string, string | undefined>,
    deps?: {
      createClient?: (href: string, options: Record<string, unknown>) => FakeBootstrapClient;
    },
  ): Promise<{ outcome: "created" | "present"; role: string; ddlIssued: boolean }>;
}

async function bootstrapModule(): Promise<BootstrapModule> {
  let loaded: unknown;
  try {
    // @ts-expect-error Standalone CI tooling has no declaration file.
    loaded = await import("../ci/staging-role-bootstrap.mjs");
  } catch (error) {
    throw new Error("Failed to load ci/staging-role-bootstrap.mjs.", { cause: error });
  }
  return loaded as BootstrapModule;
}

function workflowText(): string {
  if (!existsSync(WORKFLOW_PATH)) {
    throw new Error(
      "RED: .github/workflows/staging-role-bootstrap.yml does not exist yet — the Builder adds the fixed-purpose manual workflow there.",
    );
  }
  return readFileSync(WORKFLOW_PATH, "utf8");
}

function nonCommentLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.replace(/#.*$/, ""))
    .filter((line) => line.trim().length > 0);
}

const SECRET_NAME = "PLANETSCALE_STAGING_DATABASE_URL";
const ROLE_NAME = "two_web_app";
const CREATE_ROLE_DDL = "CREATE ROLE two_web_app NOLOGIN";
const SECRET_MARKER = "synthetic-bootstrap-marker-9f2";

const stagingUrl = (user = `role-stub.${PLANETSCALE_STAGING_BRANCH_ID}`, extra = "") =>
  `postgres://${user}:${SECRET_MARKER}@${PLANETSCALE_STAGING_HOST}/stagingdb?sslmode=require${extra}`;

const compatibleRow = (): RoleRow => ({
  rolname: ROLE_NAME,
  rolcanlogin: false,
  rolsuper: false,
  rolcreatedb: false,
  rolcreaterole: false,
  rolinherit: true,
  rolreplication: false,
  rolbypassrls: false,
  rolconnlimit: -1,
  has_memberships: false,
});

describe("bootstrap workflow is fixed-purpose, manual, staging-only", () => {
  it("dispatches manually with no inputs of any kind", () => {
    const text = workflowText();
    expect(text).toMatch(/workflow_dispatch:\s*$/m);
    expect(text).not.toMatch(/^\s+inputs:/m);
    expect(text).not.toMatch(/\$\{\{\s*inputs\./);
    expect(text).not.toMatch(/workflow_call/);
  });

  it("binds the literal staging environment, never an expression", () => {
    const text = workflowText();
    expect(text).toMatch(/^\s+environment:\s+staging\s*$/m);
    expect(text).not.toMatch(/environment:\s*\$\{\{/);
  });

  it("gates on reviewed main before dependency install or DB access", () => {
    const text = workflowText();
    expect(text).toMatch(/GITHUB_REF/);
    expect(text).toMatch(/refs\/heads\/main/);
    expect(text).toMatch(/exit 1/);
    // Pin the comparison semantics: == on refs/heads/main; an inverted != must fail.
    const gateLine =
      "[[ \"$GITHUB_REF\" == refs/heads/main ]] || { printf '%s\\n' 'Bootstrap requires main.' >&2; exit 1; }";
    expect(nonCommentLines(text).map((line) => line.trim())).toContain(gateLine);
    const gate = text.indexOf("refs/heads/main");
    for (const marker of ["npm ci", "setup-node", "staging-role-bootstrap.mjs"]) {
      const at = text.indexOf(marker);
      expect(at).toBeGreaterThan(-1);
      expect(gate).toBeLessThan(at);
    }
  });

  it("consumes the existing staging secret in place, nothing else", () => {
    const text = workflowText();
    expect(text).toContain(`secrets.${SECRET_NAME}`);
    for (const line of nonCommentLines(text)) {
      if (line.includes(SECRET_NAME)) {
        expect(line.trim()).toMatch(
          /^PLANETSCALE_STAGING_DATABASE_URL:\s*\$\{\{\s*secrets\.PLANETSCALE_STAGING_DATABASE_URL\s*\}\}$/,
        );
      }
    }
    expect(text).not.toMatch(/secrets\.PRODUCTION/);
    expect(text).not.toMatch(/^\s*DATABASE_URL\s*:/m);
    expect(text).not.toMatch(/PRODUCTION_DATABASE_URL/);
  });

  it("keeps the staging guardrails: read perms, no-cancel, timeout, single script run, no inline SQL", () => {
    const text = workflowText();
    expect(text).toMatch(/contents:\s*read/);
    expect(text).toMatch(/cancel-in-progress:\s*false/);
    const timeout = text.match(/timeout-minutes:\s*(\d+)/);
    expect(timeout).not.toBeNull();
    expect(Number(timeout?.[1])).toBeLessThanOrEqual(15);
    expect(text).toMatch(/persist-credentials:\s*false/);
    expect(text).toContain("node ci/staging-role-bootstrap.mjs");
    for (const line of nonCommentLines(text)) {
      expect(line).not.toMatch(
        /\b(CREATE|GRANT|REVOKE|ALTER|SELECT|INSERT|UPDATE|DELETE)\b.*\b(ROLE|TABLE|FROM|ON)\b/i,
      );
    }
  });
});

describe("bootstrap module pins the fixed role and constant DDL", () => {
  it("exports the fixed secret name, role name and exact DDL constant", async () => {
    const bootstrap = await bootstrapModule();
    expect(bootstrap.SECRET_NAME).toBe(SECRET_NAME);
    expect(bootstrap.ROLE_NAME).toBe(ROLE_NAME);
    expect(bootstrap.CREATE_ROLE_DDL).toBe(CREATE_ROLE_DDL);
  });

  it("accepts only the byte-exact DDL, refusing every variant and write", async () => {
    const bootstrap = await bootstrapModule();
    expect(bootstrap.assertBootstrapDdl(CREATE_ROLE_DDL)).toBe(true);
    for (const sql of [
      "create role two_web_app nologin",
      `${CREATE_ROLE_DDL};`,
      ` ${CREATE_ROLE_DDL}`,
      `${CREATE_ROLE_DDL} `,
      "CREATE ROLE two_web_app LOGIN",
      "CREATE ROLE two_web_app NOLOGIN PASSWORD 'x'",
      "CREATE ROLE other_role NOLOGIN",
      "GRANT SELECT ON TABLE public.events TO two_web_app",
      "ALTER ROLE two_web_app WITH LOGIN",
      "DROP ROLE two_web_app",
      "SELECT 1 FROM pg_roles WHERE rolname = 'two_web_app'",
    ]) {
      expect(() => bootstrap.assertBootstrapDdl(sql), sql).toThrow();
    }
  });

  it("bounds lock, statement and connect timeouts", async () => {
    const bootstrap = await bootstrapModule();
    for (const [name, value, max] of [
      ["STATEMENT_TIMEOUT_MS", bootstrap.STATEMENT_TIMEOUT_MS, 60000],
      ["LOCK_TIMEOUT_MS", bootstrap.LOCK_TIMEOUT_MS, 30000],
      ["CONNECT_TIMEOUT_SECONDS", bootstrap.CONNECT_TIMEOUT_SECONDS, 30],
    ] as const) {
      expect(Number.isInteger(value), name).toBe(true);
      expect(value, name).toBeGreaterThan(0);
      expect(value, name).toBeLessThanOrEqual(max);
    }
  });

  it("checks role state with a single SELECT against pg_roles for the fixed role", async () => {
    const bootstrap = await bootstrapModule();
    const sql = bootstrap.ROLE_STATUS_QUERY;
    expect(sql.trim()).toMatch(/^select\b/i);
    expect(sql).not.toContain(";");
    expect(sql).toContain("pg_roles");
    expect(sql).toContain(ROLE_NAME);
    for (const column of [
      "rolcanlogin",
      "rolsuper",
      "rolcreatedb",
      "rolcreaterole",
      "rolreplication",
      "rolbypassrls",
      "has_memberships",
    ]) {
      expect(sql).toContain(column);
    }
  });
});

describe("bootstrap endpoint validation fails closed", () => {
  it("accepts the pinned staging endpoint only", async () => {
    const bootstrap = await bootstrapModule();
    const url = bootstrap.validateStagingUrl(stagingUrl());
    expect(url.hostname).toBe(PLANETSCALE_STAGING_HOST);
    expect(url.port).toBe("5432");
  });

  it("refuses production identity and wrong bindings without leaking values", async () => {
    const bootstrap = await bootstrapModule();
    const cases: Array<[string, string]> = [
      [
        "production host",
        `postgres://u.${PLANETSCALE_STAGING_BRANCH_ID}:${SECRET_MARKER}@${PLANETSCALE_PRODUCTION_HOST}/stagingdb?sslmode=require`,
      ],
      ["production branch", stagingUrl(`role.${PLANETSCALE_PRODUCTION_BRANCH_ID}`)],
      [
        "retired host",
        `postgres://u:${SECRET_MARKER}@ep-neon-123.us-east-2.aws.neon.tech/stagingdb?sslmode=require`,
      ],
      ["unknown host", `postgres://u:${SECRET_MARKER}@db.example.test/stagingdb?sslmode=require`],
      [
        "missing branch suffix",
        `postgres://plainuser:${SECRET_MARKER}@${PLANETSCALE_STAGING_HOST}/stagingdb?sslmode=require`,
      ],
      [
        "missing password",
        `postgres://u.${PLANETSCALE_STAGING_BRANCH_ID}@${PLANETSCALE_STAGING_HOST}/stagingdb?sslmode=require`,
      ],
      [
        "missing TLS",
        `postgres://u.${PLANETSCALE_STAGING_BRANCH_ID}:${SECRET_MARKER}@${PLANETSCALE_STAGING_HOST}/stagingdb`,
      ],
      [
        "weak TLS",
        `postgres://u.${PLANETSCALE_STAGING_BRANCH_ID}:${SECRET_MARKER}@${PLANETSCALE_STAGING_HOST}/stagingdb?sslmode=prefer`,
      ],
      [
        "extra param",
        stagingUrl(`role-stub.${PLANETSCALE_STAGING_BRANCH_ID}`, "&options=--cluster%3Drogue"),
      ],
      ["wrong protocol", stagingUrl().replace("postgres://", "http://")],
      ["wrong port", stagingUrl().replace("/stagingdb?", ":5433/stagingdb?")],
      [
        "missing database",
        `postgres://u.${PLANETSCALE_STAGING_BRANCH_ID}:${SECRET_MARKER}@${PLANETSCALE_STAGING_HOST}/?sslmode=require`,
      ],
      ["not a URL", "not-a-url"],
    ];
    for (const [name, raw] of cases) {
      let message = "";
      try {
        bootstrap.validateStagingUrl(raw);
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message.length, name).toBeGreaterThan(0);
      expect(message, name).not.toContain(SECRET_MARKER);
      expect(message, name).not.toContain(raw.slice(0, 24));
    }
  });

  it("refuses a missing secret with no fallback", async () => {
    const bootstrap = await bootstrapModule();
    for (const raw of ["", "   "]) {
      expect(() => bootstrap.validateStagingUrl(raw)).toThrow(/missing|fallback/i);
    }
  });
});

describe("bootstrap role classification", () => {
  it("reports a missing role as absent", async () => {
    const bootstrap = await bootstrapModule();
    expect(bootstrap.classifyRole(null)).toEqual({ state: "absent" });
    expect(bootstrap.classifyRole(undefined)).toEqual({ state: "absent" });
  });

  it("accepts the NOLOGIN default attribute set as compatible", async () => {
    const bootstrap = await bootstrapModule();
    expect(bootstrap.classifyRole(compatibleRow())).toMatchObject({ state: "compatible" });
  });

  it("refuses every elevated attribute, naming the offender", async () => {
    const bootstrap = await bootstrapModule();
    const variants: Array<[string, (row: RoleRow) => void, RegExp]> = [
      [
        "login",
        (row) => {
          row.rolcanlogin = true;
        },
        /login/i,
      ],
      [
        "superuser",
        (row) => {
          row.rolsuper = true;
        },
        /super/i,
      ],
      [
        "createdb",
        (row) => {
          row.rolcreatedb = true;
        },
        /createdb/i,
      ],
      [
        "createrole",
        (row) => {
          row.rolcreaterole = true;
        },
        /createrole/i,
      ],
      [
        "replication",
        (row) => {
          row.rolreplication = true;
        },
        /replic/i,
      ],
      [
        "bypassrls",
        (row) => {
          row.rolbypassrls = true;
        },
        /bypassrls/i,
      ],
      [
        "memberships",
        (row) => {
          row.has_memberships = true;
        },
        /membership/i,
      ],
    ];
    for (const [name, mutate, pattern] of variants) {
      const row = compatibleRow();
      mutate(row);
      const verdict = bootstrap.classifyRole(row);
      expect(verdict.state, name).toBe("incompatible");
      expect(verdict.reason ?? "", name).toMatch(pattern);
    }
  });
});

describe("bootstrap orchestration over an injected client", () => {
  function fakeClient(
    behavior: (
      sql: string,
      calls: string[],
    ) => Record<string, unknown>[] | Promise<Record<string, unknown>[]>,
  ) {
    const calls: string[] = [];
    return {
      calls,
      unsafe: async (sql: string) => {
        calls.push(sql);
        return behavior(sql, calls);
      },
    };
  }

  it("creates the missing role once, then verifies presence and safe attributes", async () => {
    const bootstrap = await bootstrapModule();
    let reads = 0;
    const client = fakeClient((sql) => {
      if (sql === bootstrap.ROLE_STATUS_QUERY) {
        reads += 1;
        return reads === 1 ? [] : [compatibleRow() as unknown as Record<string, unknown>];
      }
      if (sql === CREATE_ROLE_DDL) return [];
      throw new Error(`unexpected SQL: ${sql}`);
    });
    const evidence = await bootstrap.bootstrapRole(client);
    expect(evidence).toMatchObject({ outcome: "created", role: ROLE_NAME, ddlIssued: true });
    expect(reads).toBe(2);
    expect(client.calls.filter((sql) => sql === CREATE_ROLE_DDL)).toHaveLength(1);
    expect(JSON.stringify(evidence)).not.toContain(SECRET_MARKER);
  });

  it("rejects when the post-create re-read finds no row, after issuing DDL once", async () => {
    const bootstrap = await bootstrapModule();
    const client = fakeClient((sql) => {
      if (sql === bootstrap.ROLE_STATUS_QUERY) return [];
      if (sql === CREATE_ROLE_DDL) return [];
      throw new Error(`unexpected SQL: ${sql}`);
    });
    await expect(bootstrap.bootstrapRole(client)).rejects.toThrow(/verif/i);
    expect(client.calls.filter((sql) => sql === CREATE_ROLE_DDL)).toHaveLength(1);
  });

  it("rejects when the post-create re-read finds an incompatible row", async () => {
    const bootstrap = await bootstrapModule();
    let reads = 0;
    const loginRow = compatibleRow();
    loginRow.rolcanlogin = true;
    const client = fakeClient((sql) => {
      if (sql === bootstrap.ROLE_STATUS_QUERY) {
        reads += 1;
        return reads === 1 ? [] : [loginRow as unknown as Record<string, unknown>];
      }
      if (sql === CREATE_ROLE_DDL) return [];
      throw new Error(`unexpected SQL: ${sql}`);
    });
    await expect(bootstrap.bootstrapRole(client)).rejects.toThrow(/refus/i);
    expect(reads).toBe(2);
  });

  it("treats a present compatible role as a no-op with no DDL", async () => {
    const bootstrap = await bootstrapModule();
    const client = fakeClient((sql) => {
      if (sql === bootstrap.ROLE_STATUS_QUERY) {
        return [compatibleRow() as unknown as Record<string, unknown>];
      }
      throw new Error(`unexpected SQL: ${sql}`);
    });
    const evidence = await bootstrap.bootstrapRole(client);
    expect(evidence).toMatchObject({ outcome: "present", role: ROLE_NAME, ddlIssued: false });
    expect(client.calls).toHaveLength(1);
  });

  it("refuses an incompatible role without issuing any DDL", async () => {
    const bootstrap = await bootstrapModule();
    const row = compatibleRow();
    row.rolcanlogin = true;
    const client = fakeClient((sql) => {
      if (sql === bootstrap.ROLE_STATUS_QUERY) {
        return [row as unknown as Record<string, unknown>];
      }
      throw new Error(`unexpected SQL: ${sql}`);
    });
    await expect(bootstrap.bootstrapRole(client)).rejects.toThrow(/incompatible|refus/i);
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]).toBe(bootstrap.ROLE_STATUS_QUERY);
  });

  it("refuses a role carrying memberships without issuing any DDL", async () => {
    const bootstrap = await bootstrapModule();
    const row = compatibleRow();
    row.has_memberships = true;
    const client = fakeClient((sql) => {
      if (sql === bootstrap.ROLE_STATUS_QUERY) {
        return [row as unknown as Record<string, unknown>];
      }
      throw new Error(`unexpected SQL: ${sql}`);
    });
    await expect(bootstrap.bootstrapRole(client)).rejects.toThrow(/membership/i);
    expect(client.calls).toHaveLength(1);
  });

  it("resolves a concurrent create race to present instead of failing", async () => {
    const bootstrap = await bootstrapModule();
    let reads = 0;
    const client = fakeClient((sql) => {
      if (sql === bootstrap.ROLE_STATUS_QUERY) {
        reads += 1;
        return reads === 1 ? [] : [compatibleRow() as unknown as Record<string, unknown>];
      }
      if (sql === CREATE_ROLE_DDL) {
        throw Object.assign(new Error("duplicate object"), { code: "42710" });
      }
      throw new Error(`unexpected SQL: ${sql}`);
    });
    const evidence = await bootstrap.bootstrapRole(client);
    expect(evidence).toMatchObject({ outcome: "present", role: ROLE_NAME });
    expect(JSON.stringify(evidence)).not.toContain(SECRET_MARKER);
  });

  it("withholds client, connect and DDL failure details", async () => {
    const bootstrap = await bootstrapModule();
    const statusBoom = fakeClient(() => {
      throw new Error(`status boom ${SECRET_MARKER}`);
    });
    await expect(bootstrap.bootstrapRole(statusBoom)).rejects.toThrow();
    try {
      await bootstrap.bootstrapRole(statusBoom);
      expect.unreachable("status failure must reject");
    } catch (error) {
      expect(String(error)).not.toContain(SECRET_MARKER);
    }
    expect(statusBoom.calls).toHaveLength(2);

    const ddlBoom = fakeClient((sql) => {
      if (sql === bootstrap.ROLE_STATUS_QUERY) return [];
      throw new Error(`ddl boom ${SECRET_MARKER}`);
    });
    try {
      await bootstrap.bootstrapRole(ddlBoom);
      expect.unreachable("DDL failure must reject");
    } catch (error) {
      expect(String(error)).not.toContain(SECRET_MARKER);
    }
  });

  it("keeps evidence free of connection and credential fields", async () => {
    const bootstrap = await bootstrapModule();
    const client = fakeClient((sql) => {
      if (sql === bootstrap.ROLE_STATUS_QUERY) {
        return [compatibleRow() as unknown as Record<string, unknown>];
      }
      throw new Error(`unexpected SQL: ${sql}`);
    });
    const evidence = await bootstrap.bootstrapRole(client);
    const text = JSON.stringify(evidence);
    expect(text).not.toContain(SECRET_MARKER);
    for (const key of Object.keys(evidence)) {
      expect(key).not.toMatch(/url|password|secret|connection|credential/i);
    }
    expect(text).not.toMatch(/postgres:\/\//);
  });

  it("maps unknown errors to a generic withheld message", async () => {
    const bootstrap = await bootstrapModule();
    expect(bootstrap.safeBootstrapError(new Error(`boom ${SECRET_MARKER}`))).not.toContain(
      SECRET_MARKER,
    );
    expect(bootstrap.safeBootstrapError(new Error("plain failure"))).toMatch(/withheld|failed/i);
  });
});

describe("bootstrap runner secret and connection wiring", () => {
  const throwingClient = () => {
    throw new Error("must not connect without a valid secret");
  };

  it("refuses a missing secret without connecting", async () => {
    const bootstrap = await bootstrapModule();
    await expect(bootstrap.runBootstrap({}, { createClient: throwingClient })).rejects.toThrow(
      /missing|fallback/i,
    );
  });

  it("refuses a wrong secret name without fallback", async () => {
    const bootstrap = await bootstrapModule();
    await expect(
      bootstrap.runBootstrap({ DATABASE_URL: stagingUrl() }, { createClient: throwingClient }),
    ).rejects.toThrow(/missing|fallback/i);
  });

  it("pins TLS, single connection and timeouts in the client options", async () => {
    const bootstrap = await bootstrapModule();
    const options = bootstrap.buildClientOptions(new URL(stagingUrl()));
    expect(options.port).toBe(5432);
    expect(options.max).toBe(1);
    expect(options.connect_timeout).toBe(bootstrap.CONNECT_TIMEOUT_SECONDS);
    expect(options.connection.statement_timeout).toBe(bootstrap.STATEMENT_TIMEOUT_MS);
    expect(options.connection.lock_timeout).toBe(bootstrap.LOCK_TIMEOUT_MS);
    expect(options.ssl.rejectUnauthorized).toBe(true);
  });

  it("decodes the URL password for the client", async () => {
    const bootstrap = await bootstrapModule();
    const url = new URL(
      `postgres://role-stub.${PLANETSCALE_STAGING_BRANCH_ID}:p%40ss%3Aword@${PLANETSCALE_STAGING_HOST}/stagingdb?sslmode=require`,
    );
    expect(bootstrap.buildClientOptions(url).password()).toBe("p@ss:word");
  });

  it("adopts the injected factory for a present compatible role", async () => {
    const bootstrap = await bootstrapModule();
    const seen: Array<{ href: string; options: Record<string, unknown> }> = [];
    let ends = 0;
    const fake: FakeBootstrapClient = {
      unsafe: async (sql: string) => {
        if (sql === bootstrap.ROLE_STATUS_QUERY) {
          return [compatibleRow() as unknown as Record<string, unknown>];
        }
        throw new Error(`unexpected SQL: ${sql}`);
      },
      end: async () => {
        ends += 1;
      },
    };
    const evidence = await bootstrap.runBootstrap(
      { [SECRET_NAME]: stagingUrl() },
      {
        createClient: (href: string, options: Record<string, unknown>) => {
          seen.push({ href, options });
          return fake;
        },
      },
    );
    expect(evidence).toMatchObject({ outcome: "present", role: ROLE_NAME, ddlIssued: false });
    expect(seen).toHaveLength(1);
    const [first] = seen;
    expect(first?.href).toContain(PLANETSCALE_STAGING_HOST);
    expect(first?.options).toMatchObject({ max: 1, ssl: { rejectUnauthorized: true } });
    expect(ends).toBe(1);
    expect(JSON.stringify(evidence)).not.toContain(SECRET_MARKER);
  });
});

describe("bootstrap CLI surface", () => {
  it("exposes the wired runner for the workflow step", async () => {
    const bootstrap = await bootstrapModule();
    expect(typeof bootstrap.runBootstrap).toBe("function");
  });

  it("runs a DB-free selftest that passes with no secrets present", () => {
    const env = { ...process.env };
    delete env[SECRET_NAME];
    const run = spawnSync("node", ["ci/staging-role-bootstrap.mjs", "--selftest"], {
      cwd: repoRoot,
      encoding: "utf8",
      env,
    });
    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(/PASS/);
  });

  it("exits 2 on usage errors", () => {
    const run = spawnSync("node", ["ci/staging-role-bootstrap.mjs", "--bogus-flag"], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    expect(run.status).toBe(2);
    expect(run.stderr).toMatch(/usage/i);
  });
});
