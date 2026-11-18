import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeShell } from "./shell-normalize.mjs";

function check(input, expected) {
  const normalized = normalizeShell(input, { strict: true });
  assert.equal(normalized, expected);
  assert.equal(normalizeShell(normalized, { strict: true }), normalized);
  const masked = normalizeShell(normalized, { mask: true, strict: true });
  assert.equal(masked.length, normalized.length);
  const lfOffsets = (text) => Array.from(text.matchAll(/\n/g), (m) => m.index);
  assert.deepEqual(lfOffsets(masked), lfOffsets(normalized));
  assert.equal(normalizeShell(normalized, { mask: true, strict: true }), masked);
  return masked;
}

test("logical heredoc openers retain quote semantics and mask aligned bodies", () => {
  for (const newline of ["\n", "\r\n"]) {
    const continuation = `\\${newline}`;
    const rows = [
      [`<<${continuation} EOF`, "<< EOF"],
      [`<<E${continuation}OF`, "<<EOF"],
      [`<<"E${continuation}OF"`, '<<"EOF"'],
      [`<<E${continuation}'O'${continuation}F`, "<<E'O'F"],
      [`<${continuation}<EOF`, "<<EOF"],
      [`<<${continuation}-${continuation}EOF`, "<<-EOF"],
      [`<<${continuation}${continuation}EOF`, "<<EOF"],
    ];
    for (const [opener, canonical] of rows) {
      const body = `${newline}npm run decoy${newline}${newline}EOF${newline}cd web${newline}`;
      const masked = check(`cat ${opener}${body}`, `cat ${canonical}${body}`);
      assert.doesNotMatch(masked, /npm run decoy/);
      assert.match(masked, /cd web/);
    }
  }
});

test("unquoted continuation joins body while actual quoting keeps it literal", () => {
  for (const newline of ["\n", "\r\n"]) {
    const join = `\\${newline}`;
    const body = `${newline}body ${join}EOF${newline}cd web${newline}EOF${newline}npm run real${newline}`;
    const unquoted = check(`cat <<E${join}OF${body}`, `cat <<EOF${body}`);
    assert.doesNotMatch(unquoted, /cd web/);
    assert.match(unquoted, /npm run real/);
    for (const word of ["'EOF'", "E\\OF", "E''OF"]) {
      const masked = check(`cat <<${word}${body}`, `cat <<${word}${body}`);
      assert.match(masked, /cd web/);
    }
  }
});

test("multiple complete words, empty quotes and exact tab-stripped closers", () => {
  const text = "cat <<A-b <<-'c'\\'d <<''\none\nA-b\n\tsecond\n\tc'd\n\ncd web\n";
  const masked = check(text, text);
  assert.doesNotMatch(masked.split("\n").slice(1).join("\n"), /one|second|A-b|c'd/);
  assert.match(masked, /cd web/);
  const spaces = "cat <<-EOF\n  EOF\ncd web\nEOF\nnpm run real\n";
  assert.doesNotMatch(check(spaces, spaces), /cd web/);
  const literalCr = "cat <<EOF\nEOF\r\\\n\nbody\nEOF\n";
  assert.doesNotMatch(check(literalCr, literalCr), /body/);
});

test("marker named cd and exact closers preserve the following command", () => {
  for (const newline of ["\n", "\r\n"]) {
    const source = "cat <<cd\nnpm run decoy\ncd extra\n\ncd\ncd web\nnpm run real\n".replaceAll(
      "\n",
      newline,
    );
    const masked = check(source, source);
    assert.doesNotMatch(masked, /decoy|cd extra/);
    assert.match(masked, /cd web/);
    assert.match(masked, /npm run real/);
  }
});

test("literal carriage returns in delimiters preserve following commands", () => {
  const quoted = "cat <<'EOF\r'\nbody\nEOF\r\nprintf done\n";
  check(quoted, quoted);
  for (const opener of ["<<EOF\r", "<<'EOF\r'", "<<-EOF\r"]) {
    for (const newline of ["\n", "\r\n"]) {
      const source = `cat ${opener} ;\nbody\n${opener.startsWith("<<-") ? "\t" : ""}EOF\r${newline}printf done\n`;
      const masked = check(source, source);
      assert.doesNotMatch(masked, /body/);
      assert.match(masked, /printf done/);
    }
  }
});

test("ambiguous delimiters and arithmetic subscripts fail closed", () => {
  for (const [source, error] of [
    ["cat <<EOF\r\\\n\nEOF\n# body text\nEOF\r\nprintf done\n", /ambiguous heredoc delimiter/],
    ["echo $[1 + 1]\n", /unsupported parameter expansion/],
    ["a[1<<2]=value\nprintf done\n", /arithmetic subscript/],
    ["LC_ALL=C a[1<<2]=value\n", /arithmetic subscript/],
    ["a[1\n << 2]=value\nprintf done\n", /arithmetic subscript/],
    ["a[b[0]<<2]=value\n", /arithmetic subscript/],
    ["case x in y|x ) declare a[(1 | 2) & 3 << 4]=value;; esac\n", /arithmetic subscript/],
    ["a[1\\\n<\\\n<2]=value\nprintf done\n", /arithmetic subscript/],
    ["a\\\r\nb[1<\\\r\n<2]=value\n", /arithmetic subscript/],
  ]) {
    for (const strict of [false, true])
      for (const mask of [false, true]) {
        assert.throws(() => normalizeShell(source, { strict, mask }), error);
      }
  }
});

test("single-quoted continuations and escaped-backslash parity remain literal", () => {
  for (const newline of ["\n", "\r\n"]) {
    const quoted = `echo 'a\\${newline}b'${newline}`;
    check(quoted, quoted);
    const even = `echo two\\\\${newline}npm run real${newline}`;
    check(even, even);
    const odd = `echo three\\\\\\${newline}continued${newline}`;
    check(odd, `echo three\\\\continued${newline}`);
  }
});

test("masked output is not reparsed as a closed heredoc", () => {
  const source = "cat <<EOF\nx\nEOF\ncd web\n";
  const masked = "cat <<EOF\n \n   \ncd web\n";
  assert.equal(check(source, source), masked);
  assert.equal(normalizeShell(masked, { mask: true }), "cat <<EOF\n \n   \n      \n");
});

test("comments and quote-specific continuation handling", () => {
  const text = "echo 'a\\\nb' # comment \\\nnpm run real\necho x\\\\\necho end\n";
  const expected = "echo 'a\\\nb' \nnpm run real\necho x\\\\\necho end\n";
  assert.equal(normalizeShell(text), expected);
  assert.equal(normalizeShell(expected), expected);
});

test("here-strings and arithmetic shifts are not heredocs", () => {
  check("if((1))# don't parse this comment\nthen\n:\nfi\n", "if((1))\nthen\n:\nfi\n");
  for (const source of [
    "cat <<<word\nnpm run real\n",
    "echo $((8 << 1))\nnpm run real\n",
    "echo $((1))#literal\n",
    'echo "$((1))#literal" "$$[worker]" $$[worker]\n',
    "((8 << 1))\nnpm run real\n",
    "echo 'a[1<<2]' \\<\\<\n",
  ]) {
    assert.equal(check(source, source), source);
  }
});

test("shell boundaries do not expose heredoc bodies or remove literal text", () => {
  const literals = ["'literal a[1'", '"literal a[1"', "literal\\ a[1", "a\\[1"];
  const earlierCommands = ["a[1\\]", "a[1']'"].flatMap((word) =>
    [";", " |", " |&", " ||", " &", " &&"].map((separator) => `${word}${separator} cat`),
  );
  const commands = [...literals, ...earlierCommands].map((arg) => `printf ${arg}`);
  for (const head of [
    ...commands,
    "/usr/bin/printf '%s' item[1",
    "./printf item[1",
    "LC_ALL=C printf '%s' item[1",
  ]) {
    const command = `${head} <<EOF\n`;
    const source = `${command}body\nEOF\n: item[1\nprintf done\n`;
    assert.equal(check(source, source), `${command}    \n   \n: item[1\nprintf done\n`);
  }
  const conditional = "if printf '%s' item[1 <<EOF\nbody\nEOF\nthen :; fi\n";
  assert.doesNotMatch(check(conditional, conditional), /body/);
  const escaped = "printf \\< <<EOF\nnpm run decoy\nEOF\nnpm run real\n";
  assert.doesNotMatch(check(escaped, escaped), /decoy/);
  const nonbreaking = "cat <<EOF suffix\nbody\nEOF suffix\nnpm run real\n";
  assert.match(check(nonbreaking, nonbreaking), /npm run real/);
  assert.equal(normalizeShell("echo word #literal\n"), "echo word #literal\n");
  const bareCr = "echo word\r#literal; npm run real\n";
  assert.equal(check(bareCr, bareCr), bareCr);
  assert.equal(check("echo $(\\\n(8 << 1))\n", "echo $((8 << 1))\n"), "echo $((8 << 1))\n");
  assert.throws(() => normalizeShell('echo "$(cat <<EOF\nbody\nEOF\n)"\n'), /unsupported/);
  assert.throws(() => normalizeShell("echo $'x\\' #literal'\n"), /unsupported/);
});

test("body and comment command decoys are masked or removed", () => {
  for (const newline of ["\n", "\r\n"]) {
    const source = [
      "# npm run decoy",
      "cat <<EOF",
      "npx playwright test",
      "npm run decoy",
      "",
      "EOF",
      "npx playwright test real",
      "",
    ].join(newline);
    const masked = check(source, `\n${source.slice(source.indexOf(newline) + newline.length)}`);
    assert.doesNotMatch(masked, /decoy/);
    assert.equal((masked.match(/playwright test/g) ?? []).length, 1);
  }
});

test("unsupported substitution boundaries and missing delimiters fail closed", () => {
  for (const source of [
    "echo $((true) )\n",
    "echo <(true)#suffix\n",
    "echo >\\\n(true)#suffix\n",
    "cat << # comment\n",
  ]) {
    for (const mask of [false, true]) {
      assert.throws(() => normalizeShell(source, { strict: true, mask }), /unsupported/i);
    }
  }
  for (const source of [
    "echo '<(literal)' \\>(literal)\n",
    "cat <<'#'\nbody\n#\n",
    "cat <<\\#\nbody\n#\n",
    "cat <<x#y\nbody\nx#y\n",
    "echo $(((1) + 2))\n",
  ]) {
    check(source, source);
  }
});

test("malformed openers and unsupported arithmetic fail closed", () => {
  for (const text of [
    "cat <<\\\n\n",
    "cat <<'EOF\n",
    'cat <<"EOF\n',
    "cat <<$EOF\n",
    "echo $((1 + $x))\n",
    "echo ${value:-a #b}\n",
    'echo "$\\\n{value:-a #b}"\n',
  ]) {
    assert.throws(() => normalizeShell(text, { strict: true }), /unsupported|unterminated/i, text);
  }
  assert.throws(
    () => normalizeShell("cat <<EOF\nnpm run e2e\n", { strict: true }),
    /unterminated heredoc/,
  );
  assert.doesNotThrow(() => normalizeShell("cat <<EOF\nnpm run e2e\n", { mask: true }));
});
