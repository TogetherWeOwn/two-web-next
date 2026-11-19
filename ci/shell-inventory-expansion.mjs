import assert from "node:assert/strict";
import { logicalCursor } from "./shell-heredoc-opener.mjs";

const IDENTIFIER_START = /^[A-Za-z_]$/;
const IDENTIFIER_PART = /^\w$/;
const SPECIAL_PARAMETER = /^[0-9*@#?$!\-]$/;

function readWhile(cursor, accepts) {
  let spelling = "";
  while (accepts(cursor.peek() ?? "")) spelling += cursor.take();
  return spelling;
}

function expect(cursor, spelling, diagnostic, join = true) {
  for (const ch of spelling) assert.ok(cursor.take(join) === ch, diagnostic);
  return spelling;
}

function requiredParameter(cursor, diagnostic) {
  const start = expect(cursor, "${", diagnostic);
  assert.ok(IDENTIFIER_START.test(cursor.peek() ?? ""), diagnostic);
  return (
    start + readWhile(cursor, (ch) => IDENTIFIER_PART.test(ch)) + expect(cursor, ":?}", diagnostic)
  );
}

// This is a lexical profile, not a proof of runtime dispatch. Even these
// literal heads can be shadowed. The entire substitution remains unresolved.
function readPipeline(cursor) {
  const diagnostic = "unsupported inventory command substitution";
  const take = (spelling, join) => expect(cursor, spelling, diagnostic, join);
  function space(required = false) {
    const spelling = readWhile(cursor, (ch) => ch === " " || ch === "\t");
    assert.ok(!required || spelling, diagnostic);
    return spelling;
  }
  // The inner single and double quotes belong to this grammar, not to the
  // surrounding shell word. A closer cannot occur in either operand.
  return (
    take("$(") +
    space() +
    take("printf") +
    space(true) +
    take("'") +
    take("x-access-token:%s'", false) +
    space(true) +
    take('"') +
    requiredParameter(cursor, diagnostic) +
    take('"') +
    space() +
    take("|") +
    space() +
    take("base64") +
    space(true) +
    take("-w0") +
    space() +
    take(")")
  );
}

// Only called at a live shell dollar. Arithmetic belongs to the outer scanner.
export function readInventoryExpansion(text, start, next, quote) {
  const cursor = logicalCursor(text, start);
  let kind;
  let spelling;
  if (text[next] === "(" && logicalCursor(text, next + 1).peek() !== "(") {
    assert.equal(quote, '"', "unsupported inventory command substitution");
    kind = "command-substitution";
    spelling = readPipeline(cursor);
  } else if (text[next] === "{") {
    assert.equal(quote, '"', "unsupported inventory parameter expansion");
    kind = "required-parameter";
    spelling = requiredParameter(cursor, "unsupported inventory parameter expansion");
  } else if (IDENTIFIER_START.test(text[next] ?? "") || SPECIAL_PARAMETER.test(text[next] ?? "")) {
    kind = "parameter";
    cursor.take();
    spelling = `$${IDENTIFIER_START.test(text[next]) ? readWhile(cursor, (ch) => IDENTIFIER_PART.test(ch)) : cursor.take()}`;
    // Lookahead may have skipped a continuation after the identifier. Emit
    // only the parameter spelling; the skipped bytes have no canonical offset.
  }
  return kind ? { kind, spelling, end: cursor.position } : null;
}

// Actions interpolates before Bash, regardless of shell quotes. Preserve the
// expression without interpreting it; single-quoted strings can contain `}}`.
export function readActionsExpression(text, start) {
  let quoted = false;
  for (let i = start + 3; i < text.length && !/[\r\n]/.test(text[i]); i++) {
    if (text[i] === "'") {
      if (quoted && text[i + 1] === "'") i++;
      else quoted = !quoted;
    } else if (!quoted && text.startsWith("}}", i)) {
      const end = i + 2;
      return { kind: "actions-expression", spelling: text.slice(start, end), end };
    }
  }
  assert.fail("unsupported Actions expression boundary");
}
