// A physical cursor over shell command text. The caller tracks command quotes,
// comments and arithmetic context and calls the opener only in unquoted text.
export function logicalCursor(source, offset = 0) {
  let position = offset;
  function skipContinuations() {
    while (source[position] === "\\") {
      if (source[position + 1] === "\n") position += 2;
      else if (source[position + 1] === "\r" && source[position + 2] === "\n") position += 3;
      else break;
    }
  }
  return {
    get position() {
      return position;
    },
    peek(join = true) {
      if (join) skipContinuations();
      return source[position];
    },
    take(join = true) {
      if (join) skipContinuations();
      return source[position++];
    },
  };
}

function unsupported() {
  throw new Error("Unsupported shell heredoc syntax");
}

// Called at a possible unquoted '<', never inside an arithmetic expression.
// Returns null for a non-heredoc or here-string, without consuming caller state.
export function parseHeredocOpener(source, offset = 0) {
  const cursor = logicalCursor(source, offset);
  if (cursor.take() !== "<" || cursor.take() !== "<") return null;
  if (cursor.peek() === "<") return null;
  let spelling = "<<";
  let marker = "";
  let quoted = false;
  let hasWord = false;
  let stripTabs = false;
  if (cursor.peek() === "-") {
    cursor.take();
    spelling += "-";
    stripTabs = true;
  }
  while (cursor.peek() === " " || cursor.peek() === "\t") spelling += cursor.take();

  while (true) {
    const ch = cursor.peek();
    if (ch === "<" || ch === ">") {
      const lookahead = logicalCursor(source, cursor.position);
      lookahead.take();
      if (lookahead.peek() === "(") unsupported();
    }
    const crlf = ch === "\r" && source[cursor.position + 1] === "\n";
    if (ch === undefined || /[ \t\n;&|<>()>]/.test(ch) || crlf) break;
    if (!hasWord && ch === "#") unsupported();
    hasWord = true;
    if (ch === "'" || ch === '"') {
      const quote = cursor.take();
      spelling += quote;
      quoted = true;
      while (true) {
        const inner = cursor.peek(quote !== "'");
        if (inner === undefined) unsupported();
        if (inner === quote) {
          spelling += cursor.take(false);
          break;
        }
        if (quote === '"' && inner === "\\") {
          spelling += cursor.take(false);
          const next = cursor.take(false);
          if (next === undefined) unsupported();
          spelling += next;
          marker += '$`"\\'.includes(next) ? next : `\\${next}`;
        } else {
          if (quote === '"' && (inner === "$" || inner === "`")) unsupported();
          spelling += cursor.take(false);
          marker += inner;
        }
      }
    } else if (ch === "\\") {
      spelling += cursor.take(false);
      const next = cursor.take(false);
      if (next === undefined || next === "\n" || next === "\r") unsupported();
      spelling += next;
      marker += next;
      quoted = true;
    } else {
      if (ch === "$" || ch === "`" || ch === "{" || ch === "}") unsupported();
      if ("?*+@!".includes(ch)) {
        const lookahead = logicalCursor(source, cursor.position);
        lookahead.take();
        if (lookahead.peek() === "(") unsupported();
      }
      spelling += cursor.take();
      marker += ch;
    }
  }
  if (!hasWord) unsupported();
  return { end: cursor.position, spelling, marker, stripTabs, quoted };
}
