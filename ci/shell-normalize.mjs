import assert from "node:assert/strict";
import { parseHeredocOpener } from "./shell-heredoc-opener.mjs";

export const ROOT_CWD_REMEDIATION =
  "this gate cannot resolve playwright runs outside the repo root; run the step or script at the root or teach ci/test-inventory.mjs the new form";

const CONTINUATION = /\\\r?\n/y;

// Skip escaped LF (or CRLF) pairs starting at `p`; returns the next logical
// position. Callers use it only outside single quotes.
function skipContinuations(text, p) {
  for (;;) {
    CONTINUATION.lastIndex = p;
    if (!CONTINUATION.test(text)) return p;
    p = CONTINUATION.lastIndex;
  }
}

function heredocEnds(line, marker, strip) {
  const bare = line.replace(/\r$/, "");
  return (strip ? bare.replace(/^\t+/, "") : bare) === marker;
}

// Normalize shell text the way the shell reads it: drop comments (a `#` that
// starts a token outside quotes; they end at their physical newline) and
// remove backslash-newline continuations outside single quotes. Heredoc
// openers are normalized through parseHeredocOpener. Bodies are read from the
// physical input and copied verbatim, or blanked with spaces (newlines kept,
// delimiter line included) when `mask` is set, so offsets in the normalized
// view stay aligned. An unquoted delimiter lets bash join backslash-newline
// in the body before matching; a quoted one does not. `strict` fails closed
// on an unterminated heredoc that swallows a playwright or npm run command
// and on an unterminated quote; prefix slices omit it because an open
// construct there only means the slice was cut short. Unmasked normalization
// is idempotent; masking is repeatable only from the same unmasked source.
// A masked view is terminal analysis output, not input for further parsing.
export function normalizeShell(text, { strict = false, mask = false } = {}) {
  let out = "";
  let quote = null;
  let tokenStart = true;
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
    if (c === "\\" && quote !== "'" && /^\r?\n/.test(text.slice(i + 1, i + 3))) {
      if (text[i + 1] === "\r") i++;
      i++;
      continue;
    }
    if (!quote && (c === "<" || c === ">")) {
      assert.ok(text[skipContinuations(text, i + 1)] !== "(", "unsupported process substitution");
    }
    if (!quote && c === "<") {
      const second = skipContinuations(text, i + 1);
      const third = skipContinuations(text, second + 1);
      if (text[second] === "<" && text[third] === "<") {
        out += "<<<";
        i = third;
        tokenStart = true;
        continue;
      }
      const opener = parseHeredocOpener(text, i);
      if (opener) {
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
