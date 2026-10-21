import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const runtimeRole = "two_web_app";

// Candidate ceiling from the narrowed CISO proposal; it is not execution
// authority. A newly-created object without an entry fails closed until its
// exact rights are reviewed and added here.
export const TABLE_RIGHTS = Object.freeze({
  "public.users": ["DELETE", "INSERT", "SELECT", "UPDATE"],
  "public.profiles": ["DELETE", "INSERT", "SELECT", "UPDATE"],
  "public.discord_event_snapshots": ["DELETE", "INSERT", "SELECT", "UPDATE"],
  "public.agent_event_idempotency_keys": ["DELETE", "INSERT", "SELECT"],
  "public.agent_event_audits": ["DELETE", "INSERT", "SELECT"],
  "public.agent_event_hits": ["DELETE", "INSERT", "SELECT"],
  "public.job_unique_locks": ["DELETE", "INSERT", "SELECT", "UPDATE"],
  "public.queue_jobs": ["DELETE", "INSERT", "SELECT", "UPDATE"],
  "public.featured_contents": ["DELETE", "INSERT", "SELECT", "UPDATE"],
  "public.member_data_access_logs": ["DELETE", "INSERT", "SELECT"],
  "public.rsvps": ["DELETE", "INSERT", "SELECT", "UPDATE"],
  "public.event_search_logs": ["DELETE", "INSERT", "SELECT"],
  "public.board_view_logs": ["DELETE", "INSERT", "SELECT"],
  "public.events": ["INSERT", "SELECT", "UPDATE"],
  "public.event_sync_attempts": ["INSERT", "SELECT", "UPDATE"],
  "public.queue_failed_jobs": ["DELETE", "INSERT", "SELECT"],
  "public.activity_log": ["INSERT", "SELECT"],
  "public.agent_event_grants": ["SELECT", "UPDATE(updated_at)"],
  "public.join_attempts": ["DELETE", "INSERT", "SELECT", "UPDATE"],
  "public.web_throttle_hits": ["DELETE", "INSERT", "SELECT", "UPDATE"],
  "public.web_sessions": ["DELETE", "INSERT", "SELECT", "UPDATE"],
  "public.web_oauth_journeys": ["DELETE", "INSERT", "SELECT", "UPDATE"],
});

export const SEQUENCE_RIGHTS = Object.freeze(
  Object.fromEntries(
    [
      "events_id_seq",
      "featured_contents_id_seq",
      "member_data_access_logs_id_seq",
      "activity_log_id_seq",
      "rsvps_id_seq",
      "event_search_logs_id_seq",
      "board_view_logs_id_seq",
      "agent_event_idempotency_keys_id_seq",
      "agent_event_audits_id_seq",
      "agent_event_hits_id_seq",
      "queue_failed_jobs_id_seq",
      "join_attempts_id_seq",
      "web_throttle_hits_id_seq",
    ].map((name) => [`public.${name}`, ["SELECT", "USAGE"]]),
  ),
);

const DEFAULT_ACL_QUERY = `
  SELECT d.defaclobjtype AS object_type,
         CASE WHEN d.defaclnamespace = 0 THEN '(global)' ELSE n.nspname END AS schema_name,
         CASE WHEN acl.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(acl.grantee) END AS grantee,
         pg_get_userbyid(acl.grantor) AS grantor,
         acl.privilege_type,
         acl.is_grantable
    FROM pg_default_acl AS d
    LEFT JOIN pg_namespace AS n ON n.oid = d.defaclnamespace
    CROSS JOIN LATERAL aclexplode(d.defaclacl) AS acl
   WHERE d.defaclrole = (SELECT oid FROM pg_roles WHERE rolname = current_user)
     AND d.defaclobjtype IN ('r', 'S')
     AND (d.defaclnamespace = 0 OR n.nspname = 'public')
   ORDER BY 1, 2, 3, 4, 5, 6
`;

export function validateDefaultAclRows(rows) {
  const errors = [];
  for (const row of rows) {
    const isReviewedSequenceDefault =
      row.object_type === "S" &&
      ["(global)", "public"].includes(row.schema_name) &&
      row.grantee === runtimeRole &&
      row.grantor === row.current_user &&
      ["USAGE", "SELECT"].includes(row.privilege_type) &&
      row.is_grantable === false;
    if (!isReviewedSequenceDefault) {
      errors.push(
        `unreviewed default ACL: ${row.object_type}/${row.schema_name}/${row.grantee}/${row.privilege_type}`,
      );
    }
  }
  return errors;
}

// Intentional preflight refusals. The runner surfaces only this class to the
// operator; every other error from the guard queries is a driver failure and
// must stay masked behind safeMigrationError.
export class DefaultAclRefusal extends Error {}

export async function assertRuntimeDefaultAcl(client) {
  const [identity] = await client`select current_user as current_user`;
  if (identity.current_user === runtimeRole) {
    throw new DefaultAclRefusal(
      "Migration default-ACL guard refused: migrations must not run as the runtime role.",
    );
  }
  const rows = await client.unsafe(DEFAULT_ACL_QUERY);
  const errors = validateDefaultAclRows(
    rows.map((row) => ({ ...row, current_user: identity.current_user })),
  );
  if (errors.length)
    throw new DefaultAclRefusal(`Migration default-ACL guard refused: ${errors.join("; ")}`);
}

// PostgreSQL identifier characters include non-ASCII letters (PG lexes
// high-bit bytes as identifier characters), so the census and the lexer below
// accept U+0080-U+FFFF as identifier start/continuation.
const identifier = '(?:"(?:[^"]|"")*"|[A-Za-z_\\u0080-\\uFFFF][A-Za-z0-9_$\\u0080-\\uFFFF]*)';
const relation = `(${identifier}(?:\\s*\\.\\s*${identifier})?)`;

// PostgreSQL lexing rules the guard must mirror, otherwise statements hidden
// from the census still execute at apply time (each rule below was probed
// against PostgreSQL; identifier-vs-quote decisions match or fail closed):
// - E'...' strings treat backslash as an escape, so \' does not terminate.
//   The E prefix applies only at a token start: any identifier-continue
//   character before the E (letters including non-ASCII, digits, _, $) means
//   the E extends an identifier (x1e'..' is identifier x1e plus a plain
//   string). A bare digit directly before E (1E'...') makes PostgreSQL raise
//   "trailing junk after numeric literal", so treating it as a plain string
//   fails closed: the migration cannot apply.
// - A $ tag extends an identifier, so $tag$ after an identifier-continue
//   character (t1$x$, ě$x$ — both lex as one identifier in PostgreSQL) is an
//   identifier, not a dollar-quote. After a bare digit with no identifier
//   before it (SELECT 1$x$a$x$) PostgreSQL raises a syntax error, so refusing
//   to open there fails closed as well.
// - Dollar-quote tags follow identifier-start rules ($$ or $tag$), including
//   non-ASCII letters; $1$ is a parameter followed by $, never a quote.
// - PostgreSQL concatenates a string literal with a following bare '...'
//   literal when the gap holds only whitespace and line comments with a
//   newline, and the continuation inherits the FIRST literal's escape mode
//   (probed: SELECT E'x'\n'a\'b' yields xa'b, and a GRANT hidden after such
//   a sandwich applies while a non-inheriting guard returns []). A second E
//   prefix, a dollar quote, or any block comment in the gap breaks the
//   continuation (each probed chunk then fails in PostgreSQL, so passing
//   such text fails closed). Inheriting the mode is comment-sensitive in
//   two scanners and no historical migration continues an E-string, so a
//   bare quote opening on an E-string newline gap rejects instead. The
//   split scanner sees comment-stripped text where a block comment has
//   become a space, so it rejects every whitespace-plus-newline gap after
//   an E-string, including ambiguous ones.
const DOLLAR_TAG = /^\$(?:[A-Za-z_\u0080-\uFFFF][A-Za-z0-9_\u0080-\uFFFF]*)?\$/;
const QUOTE_ABSORBING_CHAR = /[A-Za-z0-9_$\u0080-\uFFFF]/;

class UnterminatedSqlError extends Error {}

// Valid SQL the guard refuses to model; surfaced with its reason like
// unterminated input.
class UnsupportedSqlError extends Error {}

function stripComments(sql) {
  let output = "";
  let index = 0;
  let state = "normal";
  let quoteIsEscapeString = false;
  // Null when no E-string gap is open, otherwise whether a newline followed
  // the E-string. A bare quote opening on a newline gap rejects (see the
  // lexer rules above).
  let eGapNewline = null;
  let dollarTag = "";
  let blockDepth = 0;
  while (index < sql.length) {
    const rest = sql.slice(index);
    const char = sql[index];
    if (state === "line-comment") {
      if (char === "\n") {
        output += "\n";
        if (eGapNewline === false) eGapNewline = true;
        state = "normal";
      }
      index += 1;
      continue;
    }
    if (state === "block-comment") {
      if (rest.startsWith("/*")) {
        blockDepth += 1;
        index += 2;
      } else if (rest.startsWith("*/")) {
        blockDepth -= 1;
        index += 2;
        if (blockDepth === 0) {
          state = "normal";
          output += " ";
        }
      } else {
        if (char === "\n") output += "\n";
        index += 1;
      }
      continue;
    }
    if (state === "single-quote") {
      if (quoteIsEscapeString && char === "\\" && index + 1 < sql.length) {
        output += char + sql[index + 1];
        index += 2;
        continue;
      }
      output += char;
      if (char === "'" && sql[index + 1] === "'") {
        output += "'";
        index += 2;
      } else {
        if (char === "'") {
          state = "normal";
          eGapNewline = quoteIsEscapeString ? false : null;
        }
        index += 1;
      }
      continue;
    }
    if (state === "double-quote") {
      output += char;
      if (char === '"' && sql[index + 1] === '"') {
        output += '"';
        index += 2;
      } else {
        if (char === '"') state = "normal";
        index += 1;
      }
      continue;
    }
    if (state === "dollar-quote") {
      if (rest.startsWith(dollarTag)) {
        output += dollarTag;
        index += dollarTag.length;
        state = "normal";
      } else {
        output += char;
        index += 1;
      }
      continue;
    }
    if (rest.startsWith("--")) {
      // A line comment preserves a pending E-string gap: PostgreSQL
      // continuation survives it (its newline terminates the comment).
      state = "line-comment";
      index += 2;
    } else if (rest.startsWith("/*")) {
      // A block comment breaks continuation in PostgreSQL, so it breaks the
      // pending gap too.
      eGapNewline = null;
      state = "block-comment";
      blockDepth = 1;
      index += 2;
    } else if (char === "'") {
      if (eGapNewline === true)
        throw new UnsupportedSqlError(
          "E-string newline continuation is not supported; use a single string literal",
        );
      eGapNewline = null;
      state = "single-quote";
      quoteIsEscapeString =
        index > 0 &&
        (sql[index - 1] === "e" || sql[index - 1] === "E") &&
        (index < 2 || !QUOTE_ABSORBING_CHAR.test(sql[index - 2]));
      output += char;
      index += 1;
    } else if (char === '"') {
      eGapNewline = null;
      state = "double-quote";
      output += char;
      index += 1;
    } else {
      // Whitespace (and its newlines) extends an E-string gap; anything else
      // — including a dollar-quote opener — ends it.
      if (char === "\n") {
        if (eGapNewline === false) eGapNewline = true;
      } else if (!/[ \t\r\f]/.test(char)) {
        eGapNewline = null;
      }
      const dollar = rest.match(DOLLAR_TAG)?.[0];
      if (dollar && (index === 0 || !QUOTE_ABSORBING_CHAR.test(sql[index - 1]))) {
        state = "dollar-quote";
        dollarTag = dollar;
        output += dollar;
        index += dollar.length;
      } else {
        output += char;
        index += 1;
      }
    }
  }
  if (state !== "normal" && state !== "line-comment") {
    throw new UnterminatedSqlError("migration contains an unterminated string, quote, or comment");
  }
  return output;
}

function splitStatements(sql) {
  const statements = [];
  let current = "";
  let state = "normal";
  let quoteIsEscapeString = false;
  // Same E-string gap rule as stripComments, on comment-stripped text: a
  // block comment has become a space here, so any whitespace-plus-newline
  // gap after an E-string rejects, including ambiguous ones.
  let eGapNewline = null;
  let dollarTag = "";
  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index];
    const rest = sql.slice(index);
    if (state === "single-quote") {
      if (quoteIsEscapeString && char === "\\" && index + 1 < sql.length) {
        current += char + sql[index + 1];
        index += 1;
        continue;
      }
      current += char;
      if (char === "'" && sql[index + 1] === "'") {
        current += "'";
        index += 1;
      } else if (char === "'") {
        state = "normal";
        eGapNewline = quoteIsEscapeString ? false : null;
      }
      continue;
    }
    if (state === "double-quote") {
      current += char;
      if (char === '"' && sql[index + 1] === '"') {
        current += '"';
        index += 1;
      } else if (char === '"') state = "normal";
      continue;
    }
    if (state === "dollar-quote") {
      if (rest.startsWith(dollarTag)) {
        current += dollarTag;
        index += dollarTag.length - 1;
        state = "normal";
      } else current += char;
      continue;
    }
    if (char === "'") {
      if (eGapNewline === true)
        throw new UnsupportedSqlError(
          "E-string newline continuation is not supported; use a single string literal",
        );
      eGapNewline = null;
      state = "single-quote";
      quoteIsEscapeString =
        index > 0 &&
        (sql[index - 1] === "e" || sql[index - 1] === "E") &&
        (index < 2 || !QUOTE_ABSORBING_CHAR.test(sql[index - 2]));
      current += char;
    } else if (char === '"') {
      eGapNewline = null;
      state = "double-quote";
      current += char;
    } else {
      if (char === "\n") {
        if (eGapNewline === false) eGapNewline = true;
      } else if (!/[ \t\r\f]/.test(char)) {
        eGapNewline = null;
      }
      const dollar = rest.match(DOLLAR_TAG)?.[0];
      if (dollar && (index === 0 || !QUOTE_ABSORBING_CHAR.test(sql[index - 1]))) {
        state = "dollar-quote";
        dollarTag = dollar;
        current += dollar;
        index += dollar.length - 1;
      } else if (char === ";") {
        if (current.trim()) statements.push(current.trim());
        current = "";
      } else current += char;
    }
  }
  if (state !== "normal") {
    throw new UnterminatedSqlError("migration contains an unterminated string or quote");
  }
  if (current.trim()) statements.push(current.trim());
  return statements;
}

function unquote(value) {
  return value.startsWith('"') ? value.slice(1, -1).replaceAll('""', '"') : value.toLowerCase();
}

function relationName(value) {
  const parts = value.split(".").map((part) => unquote(part.trim()));
  if (parts.length > 2) return null;
  const schema = parts.length === 2 ? parts[0] : "public";
  if (schema !== "public") return null;
  return `public.${parts.at(-1)}`;
}

function pgName(value) {
  return Buffer.from(value).subarray(0, 63).toString("utf8");
}

function createdObjects(sql, errors) {
  const objects = [];
  for (const statement of splitStatements(sql)) {
    const table = statement.match(
      new RegExp(
        `^CREATE\\s+(?:(?:TEMP|TEMPORARY|UNLOGGED)\\s+)?TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${relation}`,
        "i",
      ),
    );
    if (table) {
      const name = relationName(table[1]);
      if (!name) errors.push("migration creates an object outside public");
      else {
        objects.push({ name, kind: "table" });
        const leaf = name.slice("public.".length);
        const tableBody = statement.slice(table[0].length);
        // Quoted spellings ("serial", "pg_catalog"."int8") create the same
        // backing sequences as unquoted ones, so the census accepts both. The
        // type boundary is a negative lookahead rather than \b because \b
        // matches between a word char and $ (serial$x is one identifier) and
        // never matches after a closing quote.
        const catalogPrefix = '(?:(?:pg_catalog|"pg_catalog")\\s*\\.\\s*)?';
        const serialType =
          '"(?:smallserial|serial2|serial4|serial|bigserial|serial8)"|smallserial|serial2|serial4|serial|bigserial|serial8';
        const integerType =
          '"(?:smallint|int2|integer|int4|int|bigint|int8)"|smallint|int2|integer|int4|int|bigint|int8';
        const typeBoundary = "(?![A-Za-z0-9_$\\u0080-\\uFFFF])";
        const serialColumns = [
          ...tableBody.matchAll(
            new RegExp(
              `(?:^|[, (\\n])\\s*(${identifier})\\s+${catalogPrefix}(?:${serialType})${typeBoundary}`,
              "ig",
            ),
          ),
        ];
        const identityColumns = [
          ...tableBody.matchAll(
            new RegExp(
              `(?:^|[, (\\n])\\s*(${identifier})\\s+${catalogPrefix}(?:${integerType})\\s+GENERATED\\s+(?:ALWAYS|BY\\s+DEFAULT)\\s+AS\\s+IDENTITY${typeBoundary}`,
              "ig",
            ),
          ),
        ];
        for (const match of [...serialColumns, ...identityColumns]) {
          const column = unquote(match[1]);
          objects.push({ name: `public.${pgName(`${leaf}_${column}_seq`)}`, kind: "sequence" });
        }
      }
      continue;
    }
    const sequence = statement.match(
      new RegExp(`^CREATE\\s+SEQUENCE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${relation}`, "i"),
    );
    if (sequence) {
      const name = relationName(sequence[1]);
      if (!name) errors.push("migration creates an object outside public");
      else objects.push({ name, kind: "sequence" });
      continue;
    }
    const view = statement.match(
      new RegExp(
        `^CREATE\\s+(?:OR\\s+REPLACE\\s+)?(?:RECURSIVE\\s+)?(?:MATERIALIZED\\s+)?VIEW\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${relation}`,
        "i",
      ),
    );
    if (view) {
      const name = relationName(view[1]);
      if (!name) errors.push("migration creates an object outside public");
      else objects.push({ name, kind: "view" });
    }
  }
  const seen = new Set();
  for (const object of objects) {
    if (seen.has(`${object.kind}:${object.name}`))
      errors.push(`duplicate created object: ${object.name}`);
    seen.add(`${object.kind}:${object.name}`);
  }
  return objects;
}

function grantStatements(sql, errors) {
  const grants = [];
  for (const statement of splitStatements(sql)) {
    if (!/^GRANT\b/i.test(statement)) continue;
    const match = statement.match(
      new RegExp(
        `^GRANT\\s+(.+?)\\s+ON\\s+(TABLE|SEQUENCE)\\s+${relation}\\s+TO\\s+(${identifier})(?:\\s+WITH\\s+GRANT\\s+OPTION)?$`,
        "i",
      ),
    );
    if (!match) {
      errors.push("unsupported runtime GRANT syntax");
      continue;
    }
    const columnUpdate = match[1].match(/^UPDATE\s*\(\s*(.+?)\s*\)$/i);
    const privilege = columnUpdate
      ? `UPDATE(${unquote(columnUpdate[1])})`
      : match[1].toUpperCase().replace(/\s+/g, "");
    const kind = match[2].toLowerCase() === "sequence" ? "sequence" : "table";
    const name = relationName(match[3]);
    const grantee = unquote(match[4]);
    const grantOption = /\bWITH\s+GRANT\s+OPTION\s*$/i.test(statement);
    if (privilege.includes(",")) errors.push("use one privilege per GRANT statement");
    if (grantOption) errors.push("runtime GRANT must not include grant option");
    if (/\bGRANTED\s+BY\b/i.test(statement))
      errors.push("runtime GRANT must use the current object owner");
    if (grantee !== runtimeRole) errors.push("runtime GRANT must target two_web_app only");
    if (!name) errors.push("runtime GRANT target must be in public");
    else grants.push({ kind, name, privilege, grantee });
  }
  return grants;
}

export function validateMigrationSql(fileName, source) {
  const errors = [];
  let sql;
  let statements;
  try {
    sql = stripComments(source);
    statements = splitStatements(sql);
  } catch (error) {
    return [
      `${fileName}: ${
        error instanceof UnterminatedSqlError || error instanceof UnsupportedSqlError
          ? error.message
          : "unparseable migration SQL"
      }`,
    ];
  }
  for (const statement of statements) {
    // No allowlist: SET search_path reroutes the unqualified identifiers the
    // census resolves to public, SET ROLE/session_authorization (quoted, LOCAL,
    // SESSION, or generic-GUC spellings alike) changes object ownership and
    // default ACLs, and SET standard_conforming_strings=off reopens backslash
    // escapes in plain strings, which the lexer does not model. The runner's
    // own pins are issued by the runner rather than by migration SQL, and any
    // timeout SET would only weaken those pins, so migrations cannot need SET.
    if (/^\s*SET\b/i.test(statement)) {
      errors.push(
        "SET is forbidden in runtime-rights migrations: session settings change object resolution, ownership, or string lexing outside the census",
      );
    }
    if (/^\s*RESET\b/i.test(statement)) {
      errors.push(
        "RESET is forbidden in runtime-rights migrations: it restores unreviewed session defaults outside the census",
      );
    }
    if (/^\s*DISCARD\b/i.test(statement)) {
      errors.push(
        "DISCARD is forbidden in runtime-rights migrations: it resets role and session configuration",
      );
    }
    if (/(?:"set_config"|\bset_config)\s*\(/i.test(statement)) {
      errors.push("role switching is forbidden in runtime-rights migrations");
    }
    if (/^\s*(?:CREATE|ALTER|DROP)\s+(?:ROLE|USER)\b/i.test(statement)) {
      errors.push("role changes are forbidden in runtime-rights migrations");
    }
    if (/^\s*DROP\s+OWNED\b/i.test(statement)) {
      errors.push("ownership changes are forbidden in runtime-rights migrations");
    }
    if (
      /^\s*CREATE\s+(?:(?:GLOBAL|LOCAL)\s+)?(?:TEMP|TEMPORARY)\s+(?:TABLE|SEQUENCE|VIEW)\b/i.test(
        statement,
      )
    ) {
      errors.push("temporary objects are outside the reviewed runtime-rights object census");
    }
    if (/^\s*CREATE\s+UNLOGGED\s+SEQUENCE\b/i.test(statement)) {
      errors.push("unlogged sequences are outside the reviewed runtime-rights object census");
    }
    if (/^\s*(?:SELECT|WITH)\b[\s\S]*\bINTO\b/i.test(statement)) {
      errors.push(
        "SELECT INTO object creation is outside the reviewed runtime-rights object census",
      );
    }
    if (/^\s*CREATE\s+TABLE\b/i.test(statement) && /\b(?:INHERITS\s*\(|LIKE\b)/i.test(statement)) {
      errors.push(
        "inherited or LIKE-copied table properties are outside the reviewed runtime-rights object census",
      );
    }
    if (/\b(?:nextval|currval|setval)\s*\(/i.test(statement)) {
      errors.push(
        "sequence references or mutations are outside the reviewed runtime-rights object census",
      );
    }
    if (
      /^\s*(?:ALTER\s+FUNCTION\b[\s\S]*\bSECURITY\s+DEFINER|(?:CREATE|ALTER|DROP)\s+(?:CONSTRAINT\s+)?(?:TRIGGER|RULE|POLICY|EXTENSION|SERVER)\b|ALTER\s+TABLE\b[\s\S]*\b(?:ENABLE|DISABLE|FORCE|NO\s+FORCE)\s+ROW\s+LEVEL\s+SECURITY\b)/i.test(
        statement,
      )
    ) {
      errors.push("security-sensitive DDL is outside the reviewed runtime-rights object census");
    }
    if (/^\s*(?:CREATE\s+FOREIGN\s+TABLE|IMPORT\s+FOREIGN\s+SCHEMA)\b/i.test(statement)) {
      errors.push("foreign-table creation is outside the reviewed runtime-rights object census");
    }
    if (/^\s*CREATE\s+SCHEMA\b/i.test(statement)) {
      errors.push(
        "CREATE SCHEMA schema elements are outside the reviewed runtime-rights object census",
      );
    }
    if (
      /^\s*ALTER\b[\s\S]*\bOWNER\s+TO\b/i.test(statement) ||
      /^\s*REASSIGN\s+OWNED\b/i.test(statement)
    ) {
      errors.push("object ownership changes are forbidden in runtime-rights migrations");
    }
    if (/^\s*ALTER\b[\s\S]*\bSET\s+SCHEMA\b/i.test(statement)) {
      errors.push("moving objects between schemas is forbidden in runtime-rights migrations");
    }
    if (
      /^\s*ALTER\s+TABLE\b/i.test(statement) &&
      /(?:(?<![A-Za-z0-9_$\u0080-\uFFFF])(?:smallserial|serial2|serial4|serial|bigserial|serial8|"(?:smallserial|serial2|serial4|serial|bigserial|serial8)")(?![A-Za-z0-9_$\u0080-\uFFFF])|(?<![A-Za-z0-9_$\u0080-\uFFFF])GENERATED\s+(?:ALWAYS|BY\s+DEFAULT)\s+AS\s+IDENTITY(?![A-Za-z0-9_$\u0080-\uFFFF]))/i.test(
        statement,
      )
    ) {
      errors.push(
        "ALTER TABLE sequence-generating columns are unsupported by the runtime-rights guard",
      );
    }
    if (
      /^\s*CREATE\s+TABLE\b/i.test(statement) &&
      /\bLIKE\b[\s\S]*\bINCLUDING\s+(?:IDENTITY|ALL)\b/i.test(statement)
    ) {
      errors.push("LIKE-generated identity sequences are unsupported by the runtime-rights guard");
    }
    if (/^\s*ALTER\s+DEFAULT\s+PRIVILEGES\b/i.test(statement)) {
      errors.push("ALTER DEFAULT PRIVILEGES is forbidden in migrations");
    }
    if (
      /^\s*(?:DO\b|CALL\b|CREATE\s+(?:OR\s+REPLACE\s+)?(?:FUNCTION|PROCEDURE)\b)/i.test(statement)
    ) {
      errors.push("dynamic SQL or code-defined object creation is forbidden in migrations");
    }
    if (/^\s*REVOKE\b/i.test(statement)) {
      errors.push("REVOKE is outside the reviewed per-migration rights contract");
    }
    // Persisted configuration outlives the migration: ALTER DATABASE ... SET
    // standard_conforming_strings=off would poison every later session the
    // lexer assumes escapes-free, and ALTER SYSTEM rewrites the cluster
    // configuration file. Both are outside the per-migration contract.
    if (/^\s*ALTER\s+DATABASE\b[\s\S]*\b(?:SET|RESET)\b/i.test(statement)) {
      errors.push(
        "ALTER DATABASE configuration defaults are forbidden in runtime-rights migrations",
      );
    }
    if (/^\s*ALTER\s+SYSTEM\b/i.test(statement)) {
      errors.push("ALTER SYSTEM is forbidden in runtime-rights migrations");
    }
  }

  const objects = createdObjects(sql, errors);
  const grants = grantStatements(sql, errors);
  const objectKeys = new Set(objects.map((object) => `${object.kind}:${object.name}`));
  for (const grant of grants) {
    if (!objectKeys.has(`${grant.kind}:${grant.name}`)) {
      errors.push(
        `runtime GRANT does not target an object created by this migration: ${grant.name}`,
      );
    }
  }

  for (const object of objects) {
    const rights =
      object.kind === "sequence"
        ? SEQUENCE_RIGHTS[object.name]
        : object.kind === "table"
          ? TABLE_RIGHTS[object.name]
          : undefined;
    if (!rights) {
      errors.push(`no reviewed runtime-rights entry for created ${object.kind}: ${object.name}`);
      continue;
    }
    const actual = grants
      .filter((grant) => grant.kind === object.kind && grant.name === object.name)
      .map((grant) => grant.privilege)
      .sort();
    const expected = [...rights].sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      const actualSet = new Set(actual);
      const expectedSet = new Set(expected);
      if (expected.some((right) => !actualSet.has(right))) {
        errors.push(
          `missing reviewed runtime grant for ${object.name}: ${expected.filter((right) => !actualSet.has(right)).join(", ")}`,
        );
      }
      if (actual.some((right) => !expectedSet.has(right))) {
        errors.push(
          `unreviewed runtime privilege for ${object.name}: ${actual.filter((right) => !expectedSet.has(right)).join(", ")}`,
        );
      }
      if (actual.length !== actualSet.size)
        errors.push(`duplicate runtime GRANT for ${object.name}`);
    }
  }

  return errors.map((error) => `${fileName}: ${error}`);
}

export function changedMigrationFiles(baseRef = "origin/main", cwd = repoRoot) {
  const names = execFileSync(
    "git",
    [
      "diff",
      "--no-renames",
      "--name-only",
      "--diff-filter=AM",
      `${baseRef}...HEAD`,
      "--",
      "drizzle/*.sql",
    ],
    { cwd, encoding: "utf8" },
  );
  return names
    .split("\n")
    .map((name) => name.trim())
    .filter(Boolean);
}

export function checkChangedMigrations(baseRef = "origin/main", cwd = repoRoot) {
  const failures = [];
  for (const fileName of changedMigrationFiles(baseRef, cwd)) {
    failures.push(...validateMigrationSql(fileName, readFileSync(resolve(cwd, fileName), "utf8")));
  }
  return failures;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const baseIndex = process.argv.indexOf("--base");
  const baseRef = baseIndex < 0 ? "origin/main" : process.argv[baseIndex + 1];
  if (!baseRef || baseRef.startsWith("--")) {
    console.error("Usage: node ci/migration-runtime-rights.mjs [--base <git-ref>]");
    process.exitCode = 2;
  } else {
    try {
      const failures = checkChangedMigrations(baseRef);
      if (failures.length) {
        console.error(failures.join("\n"));
        process.exitCode = 1;
      } else {
        console.log(
          `Migration runtime-rights guard passed for ${changedMigrationFiles(baseRef).length} changed migration(s).`,
        );
      }
    } catch {
      console.error("Could not compare migrations with the requested base ref; refusing to pass.");
      process.exitCode = 1;
    }
  }
}
