// Test-Author-owned, offline acceptance contract. Builder must not edit.
// runBootstrap(env, { createClient, expectedBinding }) must refuse an absent,
// incomplete or ambiguous approved binding before constructing a client. The
// expectedBinding test seam is ONE record: database, urlUsername, currentUser,
// sessionUser (nonempty strings). Production must obtain these expectations
// from an approved non-secret contract, NEVER from the URL or observed row.
// The fixture is not an attestation of any real staging identity.
//
// Compare URL database/full username before connect; then require exactly one
// SELECT current_database() AS database, current_user AS current_user,
// session_user AS session_user row on the SAME client before the role check.
// Compare all three connected values exactly with the independent binding.
// No guessed suffix stripping: PlanetScale documents branch-suffixed routing,
// not current_user/session_user normalization. Missing mapping => refuse.
// https://planetscale.com/docs/postgres/connecting/roles
// https://www.postgresql.org/docs/current/functions-info.html
// Existing endpoint/TLS/DDL/membership/timeout acceptance remains in force.
import { format } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error Standalone CI tooling has no declaration file.
import * as migratePins from "../ci/db-migrate.mjs";
// @ts-expect-error Standalone CI tooling has no declaration file.
import * as bootstrapSource from "../ci/staging-role-bootstrap.mjs";

// Imports and an accidentally dropped createClient seam must NEVER connect.
vi.mock("postgres", () => ({
  default: () => {
    throw new Error("Offline acceptance forbids real database clients.");
  },
}));

interface Binding {
  database: string;
  urlUsername: string;
  currentUser: string;
  sessionUser: string;
}
interface Client {
  unsafe(sql: string): Promise<Record<string, unknown>[]>;
  end(options?: { timeout: number }): Promise<void>;
}
interface Evidence {
  outcome: "created" | "present";
  role: string;
  ddlIssued: boolean;
}
const bootstrap = bootstrapSource as {
  runBootstrap(
    env: Record<string, string>,
    deps: {
      expectedBinding?: unknown;
      createClient(href: string, options: Record<string, unknown>): Client;
    },
  ): Promise<Evidence>;
  safeBootstrapError(error: unknown): string;
};
const { PLANETSCALE_STAGING_HOST: host, PLANETSCALE_STAGING_BRANCH_ID: branch } = migratePins as {
  PLANETSCALE_STAGING_HOST: string;
  PLANETSCALE_STAGING_BRANCH_ID: string;
};
const secretName = "PLANETSCALE_STAGING_DATABASE_URL";
const password = "synthetic-binding:marker@only";
const ddl = "CREATE ROLE two_web_app NOLOGIN";
const approved: Binding = {
  database: "synthetic_web_database",
  urlUsername: `synthetic_web_migrator.${branch}`,
  // Deliberately NOT computed by stripping the URL username's suffix. These
  // independently attested fixture values make no claim about the provider.
  currentUser: "synthetic_attested_current",
  sessionUser: "synthetic_attested_session",
};
const exactIdentity = {
  database: "synthetic_web_database",
  current_user: "synthetic_attested_current",
  session_user: "synthetic_attested_session",
};
const compatibleRole = {
  rolname: "two_web_app",
  rolcanlogin: false,
  rolsuper: false,
  rolcreatedb: false,
  rolcreaterole: false,
  rolinherit: true,
  rolreplication: false,
  rolbypassrls: false,
  rolconnlimit: -1,
  has_memberships: false,
};
function url(database = "synthetic_web_database", user = `synthetic_web_migrator.${branch}`) {
  return `postgres://${user}:${encodeURIComponent(password)}@${host}/${database}?sslmode=require`;
}
function harness({
  identityRows = [exactIdentity] as Record<string, unknown>[],
  identityError = undefined as Error | undefined,
  present = false,
  role = compatibleRole,
} = {}) {
  const sql: string[] = [];
  const connections: Array<{ href: string; options: Record<string, unknown> }> = [];
  const ends: unknown[] = [];
  let exists = present;
  const client: Client = {
    unsafe: async (statement) => {
      sql.push(statement);
      if (/^\s*SELECT\b/i.test(statement) && /current_database\s*\(/i.test(statement)) {
        if (identityError) throw identityError;
        return identityRows;
      }
      if (/^\s*SELECT\b/i.test(statement) && /\bpg_roles\b/i.test(statement)) {
        return exists ? [role] : [];
      }
      if (statement === ddl) {
        exists = true;
        return [];
      }
      throw new Error("Unexpected SQL in offline binding acceptance.");
    },
    end: async (options) => {
      ends.push(options);
    },
  };
  return {
    sql,
    connections,
    ends,
    createClient: (href: string, options: Record<string, unknown>) => {
      connections.push({ href, options });
      return client;
    },
  };
}
async function observe(
  env: Record<string, string>,
  h: ReturnType<typeof harness>,
  binding?: unknown,
) {
  const output: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...args) => output.push(format(...args)));
  vi.spyOn(console, "error").mockImplementation((...args) => output.push(format(...args)));
  let evidence: Evidence | undefined;
  let error: unknown;
  try {
    evidence = await bootstrap.runBootstrap(env, {
      createClient: h.createClient,
      expectedBinding: binding,
    });
  } catch (caught) {
    error = caught;
  }
  return {
    evidence,
    error,
    diagnostics: `${String(error ?? "")} ${error ? bootstrap.safeBootstrapError(error) : ""} ${JSON.stringify(output)}`,
  };
}
function expectRedacted(text: string, raw: string) {
  for (const value of [
    raw,
    password,
    encodeURIComponent(password),
    approved.database,
    approved.urlUsername,
    approved.currentUser,
    approved.sessionUser,
    "synthetic_other_database",
    "synthetic_bot_provisioner",
    "synthetic_other_current",
    "synthetic_other_session",
  ]) {
    expect(text).not.toContain(value);
  }
}
function expectNoWrites(statements: string[]) {
  // Every attempted statement is recorded, including unexpected statements.
  // Accept no SET ROLE, transaction/ACL/migration writes or multi-statements.
  for (const statement of statements) {
    expect(statement.trim()).toMatch(/^SELECT\b/i);
    expect(statement).not.toContain(";");
  }
}
afterEach(() => vi.restoreAllMocks());

describe("staging bootstrap requires an independent expected web binding", () => {
  it.each([
    ["missing", undefined],
    ["null", null],
    ["empty", {}],
    ["multiple candidates", [approved, { ...approved, database: "synthetic_other_database" }]],
    ["single candidate list is not an attested record", [approved]],
    ...Object.keys(approved).flatMap<[string, unknown]>((field) => [
      [`missing ${field}`, { ...approved, [field]: undefined }],
      [`blank ${field}`, { ...approved, [field]: "   " }],
      [`ambiguous ${field}`, { ...approved, [field]: [approved[field as keyof Binding]] }],
    ]),
  ])("refuses %s before client construction without writes or leaks", async (_name, binding) => {
    const h = harness();
    const raw = url();
    const result = await observe({ [secretName]: raw }, h, binding);
    expectNoWrites(h.sql);
    expectRedacted(result.diagnostics, raw);
    expect(h.sql).toEqual([]);
    expect(h.connections).toHaveLength(0);
    expect(result.evidence).toBeUndefined();
    expect(result.error).toBeInstanceOf(Error);
    expect(result.diagnostics).toMatch(/binding|attest|identity/i);
  });

  it.each([
    ["different database", url("synthetic_other_database")],
    ["bot principal on the SAME branch", url(undefined, `synthetic_bot_provisioner.${branch}`)],
  ])("refuses %s even when its connected row agrees with that URL", async (_name, raw) => {
    const parsed = new URL(raw);
    const h = harness({
      identityRows: [
        {
          database: parsed.pathname.slice(1),
          current_user: parsed.username,
          session_user: parsed.username,
        },
      ],
    });
    const result = await observe({ [secretName]: raw }, h, approved);
    expectNoWrites(h.sql);
    expectRedacted(result.diagnostics, raw);
    expect(h.sql).toEqual([]);
    expect(h.connections).toHaveLength(0);
    expect(result.error).toBeInstanceOf(Error);
    expect(result.evidence).toBeUndefined();
  });
});

describe("connected identity is checked before any role operation", () => {
  it.each([
    ["different database", [{ ...exactIdentity, database: "synthetic_other_database" }]],
    ["different current_user", [{ ...exactIdentity, current_user: "synthetic_other_current" }]],
    ["different session_user", [{ ...exactIdentity, session_user: "synthetic_other_session" }]],
    ["empty result", []],
    ["duplicate result", [exactIdentity, exactIdentity]],
    [
      "missing database",
      [{ current_user: exactIdentity.current_user, session_user: exactIdentity.session_user }],
    ],
    [
      "missing current_user",
      [{ database: exactIdentity.database, session_user: exactIdentity.session_user }],
    ],
    [
      "missing session_user",
      [{ database: exactIdentity.database, current_user: exactIdentity.current_user }],
    ],
    ["null identity", [{ ...exactIdentity, session_user: null }]],
    [
      "suffix-stripping guess",
      [
        {
          ...exactIdentity,
          current_user: "synthetic_web_migrator",
          session_user: "synthetic_web_migrator",
        },
      ],
    ],
  ])("refuses %s without touching the role or leaking identities", async (_name, rows) => {
    const h = harness({ identityRows: rows });
    const raw = url();
    const result = await observe({ [secretName]: raw }, h, approved);
    expectNoWrites(h.sql);
    expectRedacted(result.diagnostics, raw);
    expect(h.connections).toHaveLength(1);
    expect(h.sql).toHaveLength(1);
    expect(h.sql[0]).toMatch(/current_database\s*\(\s*\)/i);
    expect(h.sql[0]).not.toMatch(/\bpg_roles\b/i);
    expect(h.ends).toEqual([{ timeout: 5 }]);
    expect(result.error).toBeInstanceOf(Error);
    expect(result.evidence).toBeUndefined();
  });

  it("withholds even allowlist-looking driver errors and closes without writes", async () => {
    const raw = url();
    const h = harness({ identityError: new Error(`Bootstrap identity failed ${raw} ${password}`) });
    const result = await observe({ [secretName]: raw }, h, approved);
    expectNoWrites(h.sql);
    expectRedacted(result.diagnostics, raw);
    expect(h.sql).toHaveLength(1);
    expect(h.sql[0]).toMatch(/current_database\s*\(/i);
    expect(h.ends).toEqual([{ timeout: 5 }]);
    expect(result.error).toBeInstanceOf(Error);
  });

  it.each([
    [false, { outcome: "created", role: "two_web_app", ddlIssued: true }],
    [true, { outcome: "present", role: "two_web_app", ddlIssued: false }],
  ])(
    "exact independent binding permits compatible role create/no-op (present=%s)",
    async (present, want) => {
      const h = harness({ present });
      const raw = url();
      const result = await observe({ [secretName]: raw }, h, approved);
      expect(result.error).toBeUndefined();
      expect(result.evidence).toEqual(want);
      expectRedacted(result.diagnostics, raw);
      expect(h.connections).toHaveLength(1);
      expect(h.connections[0]?.href).toBe(new URL(raw.replace(`${host}/`, `${host}:5432/`)).href);
      expect(h.connections[0]?.options).toMatchObject({
        port: 5432,
        max: 1,
        ssl: { rejectUnauthorized: true },
        connect_timeout: 10,
        connection: { statement_timeout: 30000, lock_timeout: 10000 },
      });
      expect(h.sql[0]).toMatch(/^\s*SELECT\b/i);
      for (const expression of [
        /current_database\s*\(\s*\)/i,
        /\bcurrent_user\b/i,
        /\bsession_user\b/i,
      ]) {
        expect(h.sql[0]).toMatch(expression);
      }
      expect(h.sql[0]).not.toMatch(/\bpg_roles\b/i);
      expect(h.sql[1]).toMatch(/\bpg_roles\b/i);
      expect(h.sql.filter((statement) => !/^\s*SELECT\b/i.test(statement))).toEqual(
        present ? [] : [ddl],
      );
      expect(h.ends).toEqual([{ timeout: 5 }]);
    },
  );

  it("an exact identity does not waive the existing membership refusal", async () => {
    const h = harness({ present: true, role: { ...compatibleRole, has_memberships: true } });
    const raw = url();
    const result = await observe({ [secretName]: raw }, h, approved);
    expectNoWrites(h.sql);
    expectRedacted(result.diagnostics, raw);
    expect(result.error).toBeInstanceOf(Error);
    expect(result.diagnostics).toMatch(/membership/i);
    expect(h.sql).toHaveLength(2);
    expect(h.sql[0]).toMatch(/current_database\s*\(/i);
    expect(h.sql[1]).toMatch(/\bpg_roles\b/i);
    expect(h.ends).toEqual([{ timeout: 5 }]);
  });
});
