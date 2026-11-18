import assert from "node:assert/strict";
import { logicalCursor, parseHeredocOpener } from "./shell-heredoc-opener.mjs";

const ORDINARY_COMMAND =
  /^[ \t]*(?!(?:if|then|else|elif|fi|case|esac|for|select|while|until|do|done|in|function|time|coproc|alias|declare|typeset|local|export|readonly|builtin|command)$)[A-Za-z_]\w*$/u;
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

// Normalize comments and continuations; match unquoted heredoc closers on logical lines.
// Unmasked output is idempotent. Masking preserves body and closer offsets, but is terminal.
// Unlike prefix mode, strict mode rejects open quotes and heredocs swallowing test commands.
export function normalizeShell(text, { strict = false, mask = false } = {}) {
  let out = "";
  let quote = null;
  let tokenStart = true;
  let identifier = false;
  let commandStart = 0;
  let ordinaryCommand = false;
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
      if (c === ";" || c === "\n" || (!subscriptDepth && /[|&)]/.test(c))) {
        subscriptDepth = 0;
        ordinaryCommand = false;
        commandStart = c === ")" ? -1 : i + 1;
      } else if (commandStart >= 0 && identifier && /[ \t]/.test(c)) {
        // Keep keywords and declaration commands eligible for assignment words.
        ordinaryCommand = ORDINARY_COMMAND.test(text.slice(commandStart, i).replace(/\\\r?\n/g, ""));
        commandStart = -1;
      }
      if (c === "[" && (subscriptDepth || (!ordinaryCommand && identifier))) subscriptDepth++;
      else if (c === "]" && subscriptDepth) subscriptDepth--;
      identifier = tokenStart ? /[A-Za-z_]/.test(c) : identifier && /\w/.test(c);
    }
    assert.ok(c !== "`" || quote === "'", "unsupported command substitution");
    const expansion = c === "$" && quote !== "'";
    if (expansion || (!quote && c === "(")) {
      const next = skipContinuations(text, i + 1);
      if (expansion) {
        assert.ok(text[next] !== "'" || quote, "unsupported ANSI-C shell quote");
        assert.ok(text[next] !== "{", "unsupported parameter expansion");
      }
      if (text[next] === "(") {
        i = expansion ? skipContinuations(text, next + 1) : next;
        assert.equal(text[i], "(", "unsupported command substitution");
        out += expansion ? "$((" : "((";
        arithmetic = 2;
        tokenStart = !expansion;
        continue;
      }
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
        const { marker, stripTabs, quoted } = pending.shift();
        let closed = false;
        let body = "";
        while (pos < text.length) {
          const start = pos;
          let line = "";
          while (true) {
            const lf = text.indexOf("\n", pos);
            line += text.slice(pos, lf < 0 ? text.length : lf);
            pos = lf < 0 ? text.length : lf + 1;
            if (quoted || lf < 0 || !/(?:^|[^\\])(?:\\\\)*\\\r?$/.test(line)) break;
            line = line.replace(/\\\r?$/, "");
          }
          const raw = text.slice(start, pos);
          out += mask ? raw.replace(/[^\n]/g, " ") : raw;
          if (heredocEnds(line, marker, stripTabs)) {
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
      commandStart = pos;
      tokenStart = true;
      continue;
    }
    if (!quote && (c === "<" || c === ">")) {
      const second = skipContinuations(text, i + 1);
      assert.ok(text[second] !== "(", "unsupported process substitution");
      if (c === "<" && text[second] === "<") {
        const third = skipContinuations(text, second + 1);
        if (text[third] !== "<") {
          assert.equal(subscriptDepth, 0, "unsupported arithmetic subscript");
          const opener = parseHeredocOpener(text, i);
          assert.ok(opener, "unsupported shell heredoc syntax");
          assert.ok(
            !(opener.spelling.endsWith("\r") && text[opener.end] === "\n"),
            "unsupported ambiguous heredoc delimiter",
          );
          pending.push(opener);
          out += opener.spelling;
          i = opener.end - 1;
          tokenStart = false;
          continue;
        }
        out += "<<";
        i = third;
      } else if (text[second] === "&" || (c === ">" && text[second] === "|")) {
        out += c;
        i = second;
      }
      out += text[i];
      tokenStart = true;
      continue;
    }
    out += c;
    if (c === "\\" && quote !== "'" && i + 1 < text.length) {
      out += text[++i];
      tokenStart = false;
    } else {
      if (c === quote) quote = null;
      else if (!quote && (c === "'" || c === '"')) quote = c;
      tokenStart = !quote && /[ \t\n;|&()<>]/.test(c);
    }
  }
  assert.equal(arithmetic, 0, "unterminated arithmetic shell syntax");
  if (strict) assert.equal(quote, null, "unterminated shell quote");
  return out;
}
