import assert from "node:assert/strict";

export const ROOT_CWD_REMEDIATION =
  "this gate cannot resolve playwright runs outside the repo root; run the step or script at the root or teach ci/test-inventory.mjs the new form";

const UNSUPPORTED = "unsupported heredoc delimiter";
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

// Read a heredoc opener at `i` through a logical cursor, so continuations may
// split `<<`, the optional dash, the whitespace and the delimiter word. Returns
// null for anything that is not a heredoc (single `<`, here-string `<<<`).
// Unsupported or incomplete delimiter words throw before any body is read.
// `text` is the continuation-free opener spelling that keeps real quoting, so
// normalizing it again yields the same opener; `end` is the physical end.
function readHeredocOpener(input, i) {
  const skip = (p) => skipContinuations(input, p);
  const first = skip(i);
  const second = skip(first + 1);
  if (input[first] !== "<" || input[second] !== "<") return null;
  let p = skip(second + 1);
  if (input[p] === "<") return null;
  const strip = input[p] === "-";
  if (strip) p = skip(p + 1);
  let ws = "";
  while (p < input.length && /[ \t]/.test(input[p])) {
    ws += input[p];
    p = skip(p + 1);
  }
  let spelled = "";
  let marker = "";
  let quoted = false;
  for (;;) {
    p = skip(p);
    const c = input[p];
    if (c === undefined || /[ \t\r\n;&|()<>]/.test(c)) break;
    if (c === "'") {
      const close = input.indexOf("'", p + 1);
      assert.ok(close !== -1, UNSUPPORTED);
      spelled += input.slice(p, close + 1);
      marker += input.slice(p + 1, close);
      quoted = true;
      p = close + 1;
    } else if (c === "\\") {
      const next = input[p + 1];
      assert.ok(next !== undefined && !/[\r\n]/.test(next), UNSUPPORTED);
      spelled += c + next;
      marker += next;
      quoted = true;
      p += 2;
    } else if (c === '"') {
      spelled += c;
      quoted = true;
      p++;
      for (;;) {
        p = skip(p);
        const d = input[p];
        assert.ok(d !== undefined, UNSUPPORTED);
        p++;
        if (d === '"') break;
        if (d === "\\" && /[$`"\\]/.test(input[p] ?? "")) {
          spelled += d + input[p];
          marker += input[p++];
        } else {
          spelled += d;
          marker += d;
        }
      }
      spelled += '"';
    } else {
      assert.ok(!/[`$]/.test(c), UNSUPPORTED);
      spelled += c;
      marker += c;
      p++;
    }
  }
  // A continuation-only word is missing, not an empty quoted delimiter.
  assert.ok(spelled !== "" && !/\n/.test(marker), UNSUPPORTED);
  return { text: `<<${strip ? "-" : ""}${ws}${spelled}`, end: p, marker, strip, quoted };
}

function heredocEnds(line, marker, strip) {
  const bare = line.replace(/\r$/, "");
  return (strip ? bare.replace(/^\t+/, "") : bare) === marker;
}

// Normalize shell text the way the shell reads it: drop comments (a `#` that
// starts a token outside quotes; they end at their physical newline) and
// remove backslash-newline continuations outside single quotes. Heredoc
// openers are normalized through readHeredocOpener. Bodies are read from the
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
      out += c;
      if (c === "(") arithmetic++;
      else if (c === ")") arithmetic--;
      continue;
    }
    assert.ok(c !== "`" || quote === "'", "unsupported command substitution");
    if (quote !== "'" && c === "$") {
      const next = skipContinuations(text, i + 1);
      assert.ok(text[next] !== "'" || quote, "unsupported ANSI-C shell quote");
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
    if (!quote && c === "<") {
      const second = skipContinuations(text, i + 1);
      const third = skipContinuations(text, second + 1);
      if (text[second] === "<" && text[third] === "<") {
        out += "<<<";
        i = third;
        tokenStart = true;
        continue;
      }
      const opener = readHeredocOpener(text, i);
      if (opener) {
        pending.push(opener);
        out += opener.text;
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
    } else if (!quote) tokenStart = /[ \t\r\n;|&()<>]/.test(c);
    else tokenStart = false;
  }
  assert.equal(arithmetic, 0, "unterminated arithmetic shell syntax");
  if (strict) assert.equal(quote, null, "unterminated shell quote");
  return out;
}
