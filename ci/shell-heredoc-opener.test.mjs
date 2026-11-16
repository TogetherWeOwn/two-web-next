import assert from "node:assert/strict";
import { test } from "node:test";
import { logicalCursor, parseHeredocOpener } from "./shell-heredoc-opener.mjs";

test("opener joins continuations while retaining physical end and shell quoting", () => {
  for (const newline of ["\n", "\r\n"]) {
    const join = `\\${newline}`;
    const examples = [
      [`<${join}< ${join}EO${join}F rest`, "<< EOF", "EOF", false, false],
      [`<<${join}-${join}E${join}OF\n`, "<<-EOF", "EOF", true, false],
      [`<<"E${join}O"${join}'F'!;`, `<<"EO"'F'!`, "EOF!", false, true],
      [`<< E${join}${join}OF\n\n`, "<< EOF", "EOF", false, false],
      [`<<E\\ OF `, "<<E\\ OF", "E OF", false, true],
      [`<<'' `, "<<''", "", false, true],
      [`<<a''b `, "<<a''b", "ab", false, true],
      [`<<'a\\${newline}b' `, `<<'a\\${newline}b'`, `a\\${newline}b`, false, true],
      [`<<"a\\qb" `, '<<"a\\qb"', "a\\qb", false, true],
      [`<<"a\\\"b" `, '<<"a\\\"b"', 'a"b', false, true],
      [`<<E\\\\${join}OF `, "<<E\\\\OF", "E\\OF", false, true],
    ];
    for (const [input, spelling, marker, stripTabs, quoted] of examples) {
      const parsed = parseHeredocOpener(input);
      assert.deepEqual(
        { ...parsed, end: undefined },
        { end: undefined, spelling, marker, stripTabs, quoted },
        input,
      );
      assert.match(input.slice(parsed.end), /^[\s;]/);
      assert.deepEqual(parseHeredocOpener(`${spelling} `), { ...parsed, end: spelling.length });
    }
  }
});

test("opener consumes complete delimiter words and stops at shell boundaries", () => {
  const input = "prefix <<EOF-X <<'O'\\'Brien; rest";
  const first = parseHeredocOpener(input, 7);
  assert.deepEqual(first, {
    end: 14,
    spelling: "<<EOF-X",
    marker: "EOF-X",
    stripTabs: false,
    quoted: false,
  });
  const second = parseHeredocOpener(input, first.end + 1);
  assert.equal(second.marker, "O'Brien");
  assert.equal(input[second.end], ";");
});

test("delimiter boundaries follow shell whitespace and reject process substitution", () => {
  for (const separator of [" ", "\v", "\f", "\r"]) {
    const marker = `EOF${separator}suffix`;
    const parsed = parseHeredocOpener(`<<${marker}\n`);
    assert.equal(parsed.marker, marker);
    assert.equal(parsed.end, marker.length + 2);
  }
  for (const operator of ["<", ">", "<\\\n", ">\\\n"]) {
    assert.throws(() => parseHeredocOpener(`<<EOF${operator}(true)\n`), /Unsupported shell heredoc syntax/);
  }
  assert.equal(parseHeredocOpener("<<EOF>output\n").marker, "EOF");
});

test("logical cursor removes only unquoted or double-quoted continuations", () => {
  const cursor = logicalCursor(`a\\\nb`);
  assert.equal(cursor.take(), "a");
  assert.equal(cursor.peek(false), "\\");
  assert.equal(cursor.peek(), "b");
  assert.equal(cursor.position, 3);
});

test("unsupported and incomplete words fail closed; non-openers stay distinct", () => {
  for (const input of [
    "<<",
    "<< \\\n\n",
    "<<'unterminated",
    '<<"unterminated',
    "<<$value",
    "<<EOF\\",
    "<<{name}",
  ]) {
    assert.throws(() => parseHeredocOpener(input), /Unsupported shell heredoc syntax/, input);
  }
  assert.equal(parseHeredocOpener("< file"), null);
  assert.equal(parseHeredocOpener("<<<word"), null);
  assert.equal(parseHeredocOpener("<\\\n<<word"), null);
});
