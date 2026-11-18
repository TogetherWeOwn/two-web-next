// Read one heredoc from its first physical body offset, not from the opener end.
// Ranges are half-open string offsets; the closer includes its physical line ending.
export function readHeredocBody(source, bodyStart, { marker, stripTabs, quoted }) {
  const body = [];
  let nextOffset = bodyStart;
  while (nextOffset < source.length) {
    const lineStart = nextOffset;
    const parts = [];
    let ending;
    while (true) {
      const lf = source.indexOf("\n", nextOffset);
      const crlf = lf > nextOffset && source[lf - 1] === "\r";
      ending = lf < 0 ? "" : crlf ? "\r\n" : "\n";
      const contentEnd = lf < 0 ? source.length : crlf ? lf - 1 : lf;
      let slashStart = contentEnd;
      if (!quoted && ending) {
        while (slashStart > nextOffset && source[slashStart - 1] === "\\") slashStart--;
      }
      const joins = (contentEnd - slashStart) % 2 === 1;
      parts.push(source.slice(nextOffset, joins ? contentEnd - 1 : contentEnd));
      nextOffset = lf < 0 ? source.length : lf + 1;
      // A splice leaves an even number of trailing backslashes in the prefix.
      if (!joins) break;
    }

    const joined = parts.join("");
    const line = stripTabs ? joined.replace(/^\t+/, "") : joined;
    // A CR immediately before the final LF can also be part of a trusted marker.
    // Do not drop a literal CR exposed by a splice before a later LF.
    const matchesMarker = (text) =>
      text === marker || (ending === "\r\n" && `${text}\r` === marker);
    // A quoted marker can start with a tab, even when body indentation is stripped.
    if (matchesMarker(joined) || (stripTabs && matchesMarker(line))) {
      return {
        status: "closed",
        body: { start: bodyStart, end: lineStart },
        closer: { start: lineStart, end: nextOffset },
        nextOffset,
        logicalBody: body.join(""),
      };
    }
    body.push(line, ending);
  }
  return {
    status: "unterminated",
    body: { start: bodyStart, end: nextOffset },
    closer: null,
    nextOffset,
    logicalBody: body.join(""),
  };
}
