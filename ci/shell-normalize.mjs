import assert from "node:assert/strict";
import { readHeredocBody } from "./shell-heredoc-body.mjs";
import { logicalCursor, parseHeredocOpener } from "./shell-heredoc-opener.mjs";
import { readActionsExpression, readInventoryExpansion } from "./shell-inventory-expansion.mjs";

const ASSIGNMENT = /^[A-Za-z_]\w*\+?=/;
const LIST_PREFIX = /^(?:if|then|else|elif|while|until|do|done|fi|esac|[{}!])$/;
const ASSIGNMENT_COMMAND = /^(?:alias|declare|typeset|local|export|readonly|eval|let)$/;
const TEST_COMMAND = /\bplaywright\s+test\b|\bnpm\s+run/;
export const ROOT_CWD_REMEDIATION =
  "this gate cannot resolve playwright runs outside the repo root; run the step or script at the root or teach ci/test-inventory.mjs the new form";

function skipContinuations(text, p) {
  const cursor = logicalCursor(text, p);
  cursor.peek();
  return cursor.position;
}

// Normalize comments and continuations; masking the heredoc ranges is terminal.
// Grouped conditional regex patterns are outside this lexical subset.
// The unmasked view is idempotent. Strict mode rejects open quotes and heredocs
// swallowing test commands, even when that text would otherwise be masked.
export function normalizeShell(text, { strict = false, mask = false } = {}) {
  return scanShell(text, { strict, mask });
}

// Opt-in inventory lexical view. Ranges are half-open canonical string offsets.
// Only heredoc data and closers are masked. Dynamic ranges are unresolved, not
// evidence of an invocation, argument value, or the dispatch of a literal head.
export function normalizeInventoryShell(text) {
  const ranges = [];
  const canonical = scanShell(text, { strict: true, ranges });
  const parts = [];
  let offset = 0;
  for (const { kind, start, end } of ranges) {
    if (kind !== "heredoc-body" && kind !== "heredoc-closer") continue;
    parts.push(
      canonical.slice(offset, start),
      canonical.slice(start, end).replace(/[^\r\n]|\r(?!\n)/g, " "),
    );
    offset = end;
  }
  parts.push(canonical.slice(offset));
  return { canonical, masked: parts.join(""), ranges };
}

function rejectActionsExpression(text) {
  assert.ok(!text.includes("${{"), "unsupported Actions expression boundary");
}

function scanShell(text, { strict, mask = false, ranges }) {
  let out = "";
  let quote = null;
  let wordStart = -1;
  let head = "";
  let redirectOperand = false;
  let modifier = false;
  let arithmetic = 0;
  let arithmeticStart = 0;
  const pending = [];
  function addRange(kind, start, end) {
    if (start < end) ranges.push({ kind, start, end });
  }
  function appendExpansion({ kind, spelling, end }) {
    addRange(kind, out.length, out.length + spelling.length);
    out += spelling;
    return end - 1;
  }
  const wordAt = (end) => text.slice(wordStart, end).replace(/\\\r?\n/g, "");
  function finishWord(end, ioNumber) {
    if (wordStart < 0) return;
    if (redirectOperand) redirectOperand = false;
    else if (!head) {
      const word = wordAt(end);
      if (!(ioNumber && /^(?:\d+|\{[A-Za-z_]\w*\})$/.test(word)) && !ASSIGNMENT.test(word)) {
        assert.ok(!/^(?:function|coproc)$/.test(word), "unsupported shell command introducer");
        if (/^(?:time|command|builtin)$/.test(word)) modifier = true;
        else if (!LIST_PREFIX.test(word) && !(modifier && /^(?:-p|--)$/.test(word))) head = word;
      }
    }
    wordStart = -1;
  }
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\n" && text[i - 1] !== "\r") assert.ok(!out.endsWith("\r"), "ambiguous CRLF");
    if (arithmetic) {
      const badCloser = c === ")" && arithmetic === 2 && text[i + 1] !== ")";
      assert.ok(!badCloser && !/[\n\\'"`$#]/.test(c), "unsupported arithmetic shell syntax");
      out += c;
      if (c === "(") arithmetic++;
      else if (c === ")") {
        arithmetic--;
        if (ranges && arithmetic === 0) addRange("arithmetic", arithmeticStart, out.length);
      }
      continue;
    }
    if (c === "\\" && quote !== "'") {
      const next = skipContinuations(text, i);
      if (next !== i) {
        i = next - 1;
        continue;
      }
    }
    const tokenStart = wordStart < 0;
    if (!quote && c === "#" && tokenStart) {
      const end = text.indexOf("\n", i);
      if (ranges) rejectActionsExpression(text.slice(i, end === -1 ? undefined : end));
      if (end === -1) break;
      if (ranges && text[end - 1] === "\r") out += "\r";
      i = end - 1;
      continue;
    }
    if (ranges && text.startsWith("${{", i)) {
      if (tokenStart) wordStart = i;
      i = appendExpansion(readActionsExpression(text, i));
      continue;
    }
    const next = "<>&$(".includes(c) ? skipContinuations(text, i + 1) : i + 1;
    const redirect = !quote && (c === "<" || c === ">" || (c === "&" && text[next] === ">"));
    const separator = !quote && !redirect && /[\n;|&()]/.test(c);
    // A bare identifier followed by '[' is only subscript syntax in a
    // possible assignment position, not in an ordinary command argument.
    if (!quote && !redirectOperand && !tokenStart && (!head || ASSIGNMENT_COMMAND.test(head))) {
      if (c === "[")
        assert.ok(!/^[A-Za-z_]\w*$/.test(wordAt(i)), "unsupported arithmetic subscript");
      if (c === "(") assert.ok(!ASSIGNMENT.test(wordAt(i)), "unsupported compound assignment");
    }
    if (redirect || separator || (!quote && /[ \t]/.test(c))) finishWord(i, redirect && c !== "&");
    else if (tokenStart) wordStart = i;
    if (separator) {
      head = "";
      modifier = false;
      redirectOperand = false;
    }
    assert.ok(c !== "`" || quote === "'", "unsupported command substitution");
    const expansion = c === "$" && quote !== "'";
    if (ranges && expansion) {
      assert.ok(quote || text[next] !== '"', "unsupported locale-translated shell quote");
      assert.ok(!text.startsWith("${{", next), "unsupported Actions expression boundary");
      const span = readInventoryExpansion(text, i, next, quote);
      if (span) {
        i = appendExpansion(span);
        continue;
      }
    }
    if (expansion || (!quote && c === "(")) {
      assert.ok(!expansion || text[next] !== "'" || quote, "unsupported ANSI-C shell quote");
      assert.ok(!expansion || !["{", "["].includes(text[next]), "unsupported parameter expansion");
      if (expansion && text[next] === "$") {
        out += c;
        i = next;
      } else if (text[next] === "(") {
        i = expansion ? skipContinuations(text, next + 1) : next;
        assert.equal(text[i], "(", "unsupported command substitution");
        arithmeticStart = out.length;
        out += expansion ? "$((" : "((";
        arithmetic = 2;
        continue;
      }
    }
    if (separator && c === "\n" && pending.length) {
      out += c;
      let pos = i + 1;
      for (const opener of pending.splice(0)) {
        const body = readHeredocBody(text, pos, opener);
        if (ranges) assert.equal(body.status, "closed", "unterminated inventory heredoc");
        if (strict && body.status === "unterminated" && TEST_COMMAND.test(body.logicalBody)) {
          assert.fail(
            `unterminated heredoc <<${opener.marker} swallows a playwright or npm run command: ${ROOT_CWD_REMEDIATION}`,
          );
        }
        const raw = text.slice(body.body.start, body.nextOffset);
        if (ranges) {
          rejectActionsExpression(raw);
          // An unquoted body can execute expansions even though its text is
          // not a shell command list. Don't mask syntax this mode cannot model.
          assert.ok(
            opener.quoted || !/`|\$[({\[]/.test(body.logicalBody),
            "unsupported inventory heredoc expansion",
          );
          const closer = out.length + body.body.end - body.body.start;
          addRange("heredoc-body", out.length, closer);
          addRange("heredoc-closer", closer, out.length + raw.length);
        }
        out += mask ? raw.replace(/[^\n]/g, " ") : raw;
        pos = body.nextOffset;
      }
      i = pos - 1;
      continue;
    }
    if (redirect) {
      assert.ok(text[next] !== "(", "unsupported process substitution");
      redirectOperand = true;
      if (c === "<" && text[next] === "<") {
        const third = skipContinuations(text, next + 1);
        if (text[third] !== "<") {
          const opener = parseHeredocOpener(text, i);
          assert.ok(opener, "unsupported shell heredoc syntax");
          assert.ok(
            !(opener.spelling.endsWith("\r") && text[opener.end] === "\n"),
            "unsupported ambiguous heredoc delimiter",
          );
          if (ranges) rejectActionsExpression(text.slice(i, opener.end));
          pending.push(opener);
          out += opener.spelling;
          i = opener.end - 1;
          redirectOperand = false;
          continue;
        }
        out += "<<";
        i = third;
      } else if (text[next] === "&" || (c === ">" && text[next] === "|") || c === "&") {
        out += c;
        i = next;
      }
    }
    out += text[i];
    if (c === "\\" && quote !== "'" && i + 1 < text.length) {
      if (ranges)
        assert.ok(!text.startsWith("${{", i + 1), "unsupported Actions expression boundary");
      out += text[++i];
    } else if (c === quote) quote = null;
    else if (!quote && (c === "'" || c === '"')) quote = c;
  }
  if (ranges) assert.equal(pending.length, 0, "unterminated inventory heredoc");
  assert.equal(arithmetic, 0, "unterminated arithmetic shell syntax");
  if (strict) assert.equal(quote, null, "unterminated shell quote");
  return out;
}
