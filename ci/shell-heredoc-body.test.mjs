import assert from "node:assert/strict";
import { test } from "node:test";
import { readHeredocBody } from "./shell-heredoc-body.mjs";

const opener = { marker: "EOF", quoted: false, stripTabs: false };

function checkClosed(rawBody, rawCloser, logicalBody, metadata) {
  const prefix = "opaque prefix 🧪\n";
  const following = "untouched text\r\n";
  const source = prefix + rawBody + rawCloser + following;
  const start = prefix.length;
  const end = start + rawBody.length;
  const next = end + rawCloser.length;
  const result = readHeredocBody(source, start, { ...opener, ...metadata });
  assert.deepEqual(result, {
    status: "closed",
    body: { start, end },
    closer: { start: end, end: next },
    nextOffset: next,
    logicalBody,
  });
  assert.equal(source.slice(result.nextOffset), following);
}

test("only unquoted odd backslash runs join physical lines", () => {
  for (const nl of ["\n", "\r\n"]) {
    for (const quoted of [false, true]) {
      for (const count of [1, 2, 3, 4]) {
        const slashes = "\\".repeat(count);
        const line = `body${slashes}${nl}`;
        if (!quoted && count % 2 === 1) {
          checkClosed(`${line}EOF${nl}`, `EOF${nl}`, `body${slashes.slice(1)}EOF${nl}`, { quoted });
        } else {
          checkClosed(line, `EOF${nl}`, line, { quoted });
        }
      }
    }
    checkClosed(`body${nl}`, `E\\${nl}O\\${nl}F${nl}`, `body${nl}`);
    checkClosed(`E\\${nl}O\\${nl}F${nl}`, `EOF${nl}`, `E\\${nl}O\\${nl}F${nl}`, { quoted: true });
  }
});

test("only physical CRLF permits matching with or without its final CR", () => {
  const raw = "EOF\r\\\n\nmid\rdle\n";
  checkClosed(raw, "EOF\r\n", "EOF\r\nmid\rdle\n");
  for (const quoted of [false, true]) {
    checkClosed("body\n", "EOF\r\n", "body\n", { marker: "EOF\r", quoted });
    checkClosed("body\n", "EOF\r\r\n", "body\n", { marker: "EOF\r", quoted });
  }
  checkClosed("EOF\r\r\n", "EOF\n", "EOF\r\r\n");
  checkClosed("body\n", "E\rOF\n", "body\n", { marker: "E\rOF" });
});

test("closers must be exact; only requested leading tabs are stripped", () => {
  const raw = "\tEOF-extra\n\tEOF \n EOF\n\t $name\n\tfirst\\\n\tsecond\n";
  checkClosed(raw, "\tEOF\n", "EOF-extra\nEOF \n EOF\n $name\nfirst\tsecond\n", {
    stripTabs: true,
  });
  checkClosed("\tEOF\n\tbody\n", "EOF\n", "\tEOF\n\tbody\n");
  checkClosed(" \n", "\r\n", " \n", { marker: "", quoted: true });
  checkClosed(" \n", "\t\r\n", " \n", { marker: "", quoted: true, stripTabs: true });
  checkClosed("", "\n", "", { marker: "", quoted: true });
});

test("a tab-prefixed marker matches before tab stripping", () => {
  const metadata = { marker: "\tEND", quoted: true, stripTabs: true };
  checkClosed("\tdata\n", "\tEND\n", "data\n", metadata);
  checkClosed("\tdata\r\n", "\tEND\r\n", "data\r\n", metadata);
  checkClosed("\tdata\n", "\tEND\r\n", "data\n", { ...metadata, marker: "\tEND\r" });
});

test("EOF does not invent a newline or an empty closer", () => {
  for (const [source, logicalBody, marker] of [
    ["prefix\n\tpart\\\r\nial", "partial", "EOF"],
    ["prefix\n\tpartial\\\n", "partial", "EOF"],
    ["prefix\n\tEOF\r", "EOF\r", "EOF"],
    ["prefix\n", "", ""],
  ]) {
    assert.deepEqual(readHeredocBody(source, 7, { ...opener, stripTabs: true, marker }), {
      status: "unterminated",
      body: { start: 7, end: source.length },
      closer: null,
      nextOffset: source.length,
      logicalBody,
    });
  }
  assert.deepEqual(readHeredocBody("body\nEOF", 0, opener), {
    status: "closed",
    body: { start: 0, end: 5 },
    closer: { start: 5, end: 8 },
    nextOffset: 8,
    logicalBody: "body\n",
  });
});

test("the next physical offset is the start of the next queued body", () => {
  const source = "openers\r\nfirst\r\nEOF\r\n\tsecond\n\tEND\nfollowing\n";
  const first = readHeredocBody(source, 9, opener);
  const second = readHeredocBody(source, first.nextOffset, {
    marker: "END",
    quoted: true,
    stripTabs: true,
  });
  assert.equal(first.status, "closed");
  assert.equal(first.logicalBody, "first\r\n");
  assert.deepEqual(second, {
    status: "closed",
    body: { start: 21, end: 29 },
    closer: { start: 29, end: 34 },
    nextOffset: 34,
    logicalBody: "second\n",
  });
  assert.equal(source.slice(second.nextOffset), "following\n");
});
