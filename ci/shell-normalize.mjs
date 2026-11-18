import assert from "node:assert/strict";
import { logicalCursor, parseHeredocOpener } from "./shell-heredoc-opener.mjs";

export const ROOT_CWD_REMEDIATION =
  "this gate cannot resolve playwright runs outside the repo root; run the step or script at the root or teach ci/test-inventory.mjs the new form";

function skipContinuations(text, p) {
  const cursor = logicalCursor(text, p);
  cursor.peek();
  return cursor.position;
}

function heredocEnds(line, marker, strip) {
  const bare = strip ? line.replace(/^\t+/, "") : line;
  return bare === marker || (bare.endsWith("\r") && bare.slice(0, -1) === marker);
}

// Drop token-leading comments and join continuations outside single quotes.
// Copy heredoc bodies verbatim, or mask them and their closers without moving
// offsets. For an unquoted delimiter, join continuations before matching it.
// Strict mode rejects open quotes and heredocs that swallow test invocations;
// prefix slices may end inside either construct. The unmasked view is
// idempotent. The masked view is terminal output, not input for reparsing.
export function normalizeShell(text, { strict = false, mask = false } = {}) {
  let out = "";
  let quote = null;
  let tokenStart = true;
  let identifier = false;
  let subscriptDepth = 0;
  let arithmetic = 0;
  const pending = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (arithmetic) {
      assert.ok(!/[\n\\'"`$#]/.test(c), "unsupported arithmetic shell syntax");
      assert.ok(
        c !== ")" || arithmetic !== 2 || text[i + 1] === ")",
        "unsupported arithmetic shell syntax",
      );
      out += c;
      if (c === "(") arithmetic++;
      else if (c === ")") arithmetic--;
      continue;
    }
    if (c === "\\" && quote !== "'") {
      const next = skipContinuations(text, i);
      if (next !== i) {
        i = next - 1;
        continue;
      }
    }
    if (!quote) {
      // Track only unquoted, unescaped NAME[...], across logical continuations.
      if (c === "[" && (identifier || subscriptDepth)) subscriptDepth++;
      else if (c === "]" && subscriptDepth) subscriptDepth--;
      else if (c === ";" || c === "\n") subscriptDepth = 0;
      identifier = tokenStart ? /[A-Za-z_]/.test(c) : identifier && /\w/.test(c);
    }
    assert.ok(c !== "`" || quote === "'", "unsupported command substitution");
    if (quote !== "'" && c === "$") {
      const next = skipContinuations(text, i + 1);
      assert.ok(text[next] !== "'" || quote, "unsupported ANSI-C shell quote");
      assert.ok(text[next] !== "{", "unsupported parameter expansion");
      if (text[next] === "(") {
        const after = skipContinuations(text, next + 1);
        if (text[after] === "(") {
          out += "$((";
          i = after;
          arithmetic = 2;
          tokenStart = false;
          continue;
        }
        assert.fail("unsupported command substitution");
      }
    }
    if (!quote && c === "(" && text[skipContinuations(text, i + 1)] === "(") {
      out += "((";
      i = skipContinuations(text, i + 1);
      arithmetic = 2;
      tokenStart = true;
      continue;
    }
    if (!quote && c === "#" && tokenStart) {
      const end = text.indexOf("\n", i);
      if (end === -1) break;
      i = end - 1;
      continue;
    }
    if (c === "\n" && !quote && pending.length > 0) {
      out += c;
      let pos = i + 1;
      while (pending.length > 0) {
        const { marker, strip, quoted } = pending.shift();
        let closed = false;
        let body = "";
        while (pos < text.length) {
          const start = pos;
          let end = text.indexOf("\n", pos);
          let stop = end === -1 ? text.length : end;
          let line = text.slice(pos, stop);
          while (!quoted && end !== -1 && /(?:^|[^\\])(?:\\\\)*\\\r?$/.test(line)) {
            pos = end + 1;
            end = text.indexOf("\n", pos);
            stop = end === -1 ? text.length : end;
            line = `${line.replace(/\\\r?$/, "")}${text.slice(pos, stop)}`;
          }
          const raw = text.slice(start, end === -1 ? stop : end + 1);
          out += mask ? raw.replace(/[^\n]/g, " ") : raw;
          pos = end === -1 ? stop : end + 1;
          if (heredocEnds(line, marker, strip)) {
            closed = true;
            break;
          }
          body += `${line}\n`;
        }
        if (strict && !closed && /\bplaywright\s+test\b|\bnpm\s+run/.test(body)) {
          assert.fail(
            `unterminated heredoc <<${marker} swallows a playwright or npm run command: ${ROOT_CWD_REMEDIATION}`,
          );
        }
      }
      i = pos - 1;
      tokenStart = true;
      continue;
    }
    if (!quote && (c === "<" || c === ">")) {
      const second = skipContinuations(text, i + 1);
      assert.ok(text[second] !== "(", "unsupported process substitution");
      if (c === ">" || text[second] !== "<") {
        out += c;
        tokenStart = true;
        continue;
      }
      const third = skipContinuations(text, second + 1);
      if (text[third] === "<") {
        out += "<<<";
        i = third;
        tokenStart = true;
        continue;
      }
      assert.equal(subscriptDepth, 0, "unsupported arithmetic subscript");
      const opener = parseHeredocOpener(text, i);
      if (opener) {
        assert.ok(
          !(opener.spelling.endsWith("\r") && text[opener.end] === "\n"),
          "unsupported ambiguous heredoc delimiter",
        );
        pending.push({ ...opener, strip: opener.stripTabs });
        out += opener.spelling;
        i = opener.end - 1;
        tokenStart = false;
        continue;
      }
    }
    out += c;
    if (c === "\\" && quote !== "'" && i + 1 < text.length) {
      out += text[++i];
      tokenStart = false;
    } else if (quote && c === quote) quote = null;
    else if (!quote && (c === "'" || c === '"' || c === "`")) {
      quote = c;
      tokenStart = false;
    } else if (!quote) tokenStart = /[ \t\n;|&()<>]/.test(c);
    else tokenStart = false;
  }
  assert.equal(arithmetic, 0, "unterminated arithmetic shell syntax");
  if (strict) assert.equal(quote, null, "unterminated shell quote");
  return out;
}
