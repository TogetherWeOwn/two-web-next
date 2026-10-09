#!/usr/bin/env node
// Checks relative file links and `#anchor` fragments in the Markdown files
// GitHub renders for this repo: README.md, CONTRIBUTING.md, SECURITY.md and
// docs/**/*.md. External `http(s)` links are ignored (no network); fenced
// code blocks and inline code spans are skipped.
//
// Exit codes: 0 = every link resolves, 1 = at least one broken link,
// 2 = usage error or an unreadable file (fail closed, like check-bundle-budget).
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT_FILES = ["README.md", "CONTRIBUTING.md", "SECURITY.md"];
const DOCS_DIR = "docs";

// A link target with a URI scheme (http:, https:, mailto:, data:, ...) or a
// root-absolute path (/TOG/issues/..., /admin, ...) is not a relative file
// link, so the checker leaves it alone.
function isSkippedTarget(target) {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(target) || target.startsWith("/");
}

function isMarkdownFile(path) {
  return /\.(md|markdown|mdown)$/i.test(path);
}

// Rendered heading text, the way GitHub slugs it: links and images contribute
// their visible text, code spans contribute their content, and emphasis pairs
// contribute their inner text. Intra-word underscores are literal text (kept),
// so `_` emphasis only counts at word boundaries.
function stripTagRuns(input) {
  const text = String(input);
  let output = "";
  let inTag = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    // Only `<` followed by a letter, `/` or `!` starts raw HTML (CommonMark).
    // A bare `<` (for example `p95 < 300 ms`) is literal text, so keeping it
    // preserves the rest of the heading for the slug.
    if (!inTag && char === "<") {
      if (/[A-Za-z/!]/.test(text[i + 1] ?? "")) {
        inTag = true;
        continue;
      }
      output += char;
      continue;
    }
    if (char === ">" && inTag) {
      inTag = false;
      continue;
    }
    if (!inTag) output += char;
  }
  return output;
}
export function headingText(raw) {
  // Markdown heading text is plain-text input and the return value is a
  // slug-comparison string, never HTML output. Tags are stripped with a
  // single-pass scanner (not a repeated regex replace) before links,
  // images, code spans and emphasis below.
  let text = stripTagRuns(String(raw));
  text = text.replace(/!\[([^\]]*)\]\([^()]*\)/g, "$1");
  text = text.replace(/\[([^\]]*)\]\([^()]*\)/g, "$1");
  text = text.replace(/\[([^\]]*)\]\[[^\]]*\]/g, "$1");
  text = text.replace(/``([^`]+)``/g, "$1");
  text = text.replace(/`([^`]*)`/g, "$1");
  text = text.replace(/\*\*([^*]+)\*\*/g, "$1");
  text = text.replace(/(?<!\w)__([^_]+)__(?!\w)/g, "$1");
  text = text.replace(/\*([^*]+)\*/g, "$1");
  text = text.replace(/(?<!\w)_([^_]+)_(?!\w)/g, "$1");
  text = text.replace(/~~([^~]+)~~/g, "$1");
  return text;
}

// GitHub heading slugs: lowercase, drop every character except Unicode
// letters/numbers, spaces, hyphens and underscores, then turn each remaining
// space into one hyphen (so a double space becomes `--`, not `-`).
export function slugifyHeading(raw) {
  return headingText(raw)
    .replace(/\s/g, " ")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N} _-]/gu, "")
    .replace(/ /g, "-");
}

// Every `#anchor` GitHub generates for a Markdown source: one slug per ATX
// heading (duplicate headings gain `-1`, `-2`, ... suffixes, first wins the
// bare slug), plus explicit `id`/`name` attributes on raw HTML elements.
// Headings inside fenced code blocks are code samples, not headings.
export function collectAnchors(text) {
  const anchors = new Set();
  const seen = new Map();
  let fenceChar = null;
  let fenceLength = 0;
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const fence = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fenceChar) {
      if (line.trimStart().startsWith(fenceChar) && /^\s*(`{3,}|~{3,})/.test(line)) {
        const run = /^\s*(`{3,}|~{3,})/.exec(line)[1];
        if (run[0] === fenceChar && run.length >= fenceLength) {
          fenceChar = null;
          fenceLength = 0;
        }
      }
      continue;
    }
    if (fence) {
      fenceChar = fence[1][0];
      fenceLength = fence[1].length;
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const raw = heading[2].replace(/\s+#+\s*$/, "");
      const base = slugifyHeading(raw);
      if (!base) continue;
      const count = seen.get(base) ?? 0;
      seen.set(base, count + 1);
      anchors.add(count === 0 ? base : `${base}-${count}`);
    }
    for (const match of line.matchAll(
      /<[a-zA-Z][^<>]*\s(?:id|name)\s*=\s*["']([^"'<>]+)["'][^<>]*>/g,
    )) {
      anchors.add(match[1]);
    }
  }
  return anchors;
}

function stripInlineCode(line) {
  let previous;
  let text = line;
  do {
    previous = text;
    text = text.replace(/``[^`]*``/g, "``").replace(/`[^`\n]*`/g, "");
  } while (text !== previous);
  return text;
}

// Inline links `[text](target)` and images `![alt](target)` on one line,
// with balanced-paren destinations (titles after a space are dropped).
// Returns [{ text, target, index }].
function scanInlineLinks(line) {
  const links = [];
  const pattern = /!?\[([^\]\n]*)\]\(/g;
  let match;
  while ((match = pattern.exec(line)) !== null) {
    let depth = 1;
    let cursor = match.index + match[0].length;
    while (cursor < line.length && depth > 0) {
      if (line[cursor] === "(") depth += 1;
      else if (line[cursor] === ")") depth -= 1;
      cursor += 1;
    }
    if (depth !== 0) continue;
    const inside = line.slice(match.index + match[0].length, cursor - 1).trim();
    if (!inside) continue;
    let target;
    if (inside.startsWith("<")) {
      const close = inside.indexOf(">");
      if (close === -1) continue;
      target = inside.slice(1, close).trim();
    } else {
      target = inside.split(/\s+/)[0];
    }
    if (!target) continue;
    links.push({ text: match[1], target, index: match.index });
    pattern.lastIndex = cursor;
  }
  return links;
}

function decodeTarget(target) {
  try {
    return decodeURIComponent(target);
  } catch {
    return target;
  }
}

// Reference definitions `[label]: target` outside fenced code, for the
// `[text][label]` and `[text][]` links below. Bare `[text]` shortcuts stay
// unchecked: they are indistinguishable from prose brackets.
function collectDefinitions(lines, inCode) {
  const definitions = new Map();
  lines.forEach((line, index) => {
    if (inCode[index]) return;
    const match = /^\s{0,3}\[([^\]\n]+)\]:\s*(\S+)/.exec(line);
    if (match) definitions.set(match[1].toLowerCase(), match[2]);
  });
  return definitions;
}

function scanReferenceLinks(line, definitions) {
  const links = [];
  const pattern = /!\[([^\]\n]*)\]\[([^\]\n]*)\]|\[([^\]\n]+)\]\[([^\]\n]*)\]/g;
  let match;
  while ((match = pattern.exec(line)) !== null) {
    const label =
      (match[2] ?? match[4] ?? "").toLowerCase() || (match[1] ?? match[3]).toLowerCase();
    const target = definitions.get(label);
    if (target) links.push({ text: match[1] ?? match[3], target, index: match.index });
  }
  return links;
}

function fenceMask(lines) {
  const inCode = new Array(lines.length).fill(false);
  let fenceChar = null;
  let fenceLength = 0;
  lines.forEach((line, index) => {
    if (fenceChar) {
      inCode[index] = true;
      const run = /^\s*(`{3,}|~{3,})/.exec(line);
      if (run && run[1][0] === fenceChar && run[1].length >= fenceLength) {
        fenceChar = null;
        fenceLength = 0;
      }
      return;
    }
    const run = /^\s*(`{3,}|~{3,})/.exec(line);
    if (run) {
      inCode[index] = true;
      fenceChar = run[1][0];
      fenceLength = run[1].length;
    }
  });
  return inCode;
}

function walkMarkdownFiles(root) {
  const files = [];
  for (const name of ROOT_FILES) files.push(join(root, name));
  const docs = join(root, DOCS_DIR);
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && /\.md$/i.test(entry.name)) files.push(path);
    }
  };
  walk(docs);
  return files;
}

export function checkLinks(root, output = console) {
  let files;
  try {
    files = walkMarkdownFiles(root);
  } catch (error) {
    output.error(`doc links: cannot list Markdown files: ${error.message}`);
    return 2;
  }
  const anchorCache = new Map();
  const anchorsFor = (path) => {
    if (!anchorCache.has(path)) {
      anchorCache.set(path, collectAnchors(readFileSync(path, "utf8")));
    }
    return anchorCache.get(path);
  };
  const errors = [];
  for (const file of files) {
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch (error) {
      output.error(`doc links: cannot read ${file}: ${error.message}`);
      return 2;
    }
    const lines = text.split(/\r?\n/);
    const inCode = fenceMask(lines);
    const definitions = collectDefinitions(lines, inCode);
    lines.forEach((rawLine, index) => {
      if (inCode[index]) return;
      const line = stripInlineCode(rawLine);
      const links = [...scanInlineLinks(line), ...scanReferenceLinks(line, definitions)];
      // Relative autolinks such as <./other.md#anchor>.
      for (const match of line.matchAll(/<(\.{1,2}\/[^<>\s]*)>/g)) {
        links.push({ text: "", target: match[1], index: match.index });
      }
      for (const link of links) {
        const hash = link.target.indexOf("#");
        const pathPart = (hash === -1 ? link.target : link.target.slice(0, hash)).split("?")[0];
        const fragment = hash === -1 ? "" : link.target.slice(hash + 1);
        if (pathPart === "" && fragment === "") continue;
        if (pathPart !== "" && isSkippedTarget(pathPart)) continue;
        const decodedPath = decodeTarget(pathPart);
        const resolved = pathPart === "" ? file : resolve(dirname(file), decodedPath);
        if (!existsSync(resolved)) {
          errors.push(`${file}:${index + 1}: missing link target "${link.target}" (from ${file})`);
          continue;
        }
        if (!fragment) continue;
        let isDirectory = false;
        try {
          isDirectory = statSync(resolved).isDirectory();
        } catch {
          continue;
        }
        // Directory listings and non-Markdown files have no heading anchors.
        if (isDirectory || !isMarkdownFile(resolved)) continue;
        const fragmentDecoded = decodeTarget(fragment);
        if (!anchorsFor(resolved).has(fragmentDecoded)) {
          errors.push(
            `${file}:${index + 1}: missing anchor "#${fragment}" in "${link.target}" (from ${file})`,
          );
        }
      }
    });
  }
  // Friendly relative paths in output; absolute paths only for files outside root.
  // Keep output deterministic for review.
  const pretty = errors.map((error) => error.replaceAll(`${root}/`, "")).sort();
  for (const error of pretty) output.error(`doc links: ${error}`);
  if (pretty.length) {
    output.error(`doc links: ${pretty.length} broken link(s).`);
    return 1;
  }
  output.log(`doc links: ok (${files.length} Markdown files).`);
  return 0;
}

function selftest() {
  const root = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || tmpdir(), "doc-links-"));
  let cases = 0;
  try {
    const check = (name, setup, expected, diagnostics = []) => {
      rmSync(root, { recursive: true, force: true });
      mkdirSync(root, { recursive: true });
      setup();
      const messages = [];
      const code = checkLinks(root, {
        log() {},
        error(text) {
          messages.push(text);
        },
      });
      assert.equal(code, expected, `${name}: exit ${code}, got ${messages.join("; ")}`);
      for (const diagnostic of diagnostics) {
        assert.ok(
          messages.some((text) => text.includes(diagnostic)),
          `${name}: missing diagnostic ${JSON.stringify(diagnostic)} in ${messages.join("; ")}`,
        );
      }
      cases += 1;
      console.log(`PASS ${name}`);
    };
    const write = (path, content) => {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    };
    const target = [
      "# Target",
      "",
      "## Setup",
      "",
      "Some words.",
      "",
      "## Setup",
      "",
      "## Change-gated CI and `ci-ok`",
      "",
      "## Production cutover capability ↔ reverse map",
      "",
    ].join("\n");

    check(
      "good links pass",
      () => {
        write("README.md", "# Root\n");
        write("CONTRIBUTING.md", "# Contributing\n");
        write("SECURITY.md", "# Security\n");
        write(
          "docs/good.md",
          [
            "# Hello World",
            "",
            "[file](target.md)",
            "[same](#hello-world)",
            "[cross](target.md#setup)",
            "[duplicate](target.md#setup-1)",
            "[code heading](target.md#change-gated-ci-and-ci-ok)",
            "[punctuation](target.md#production-cutover-capability--reverse-map)",
            "[external](https://example.com/target.md#setup)",
            "[mail](mailto:someone@example.com)",
            "[root absolute](/TOG/issues/1)",
            "",
          ].join("\n"),
        );
        write("docs/target.md", target);
      },
      0,
    );

    check(
      "broken links fail with file, line and target",
      () => {
        write("README.md", "# Root\n");
        write("CONTRIBUTING.md", "# Contributing\n");
        write("SECURITY.md", "# Security\n");
        write(
          "docs/page.md",
          ["# Page", "", "[lost](missing.md)", "[anchor](target.md#no-such-anchor)"].join("\n"),
        );
        write("docs/target.md", target);
      },
      1,
      [
        'docs/page.md:3: missing link target "missing.md"',
        'docs/page.md:4: missing anchor "#no-such-anchor"',
      ],
    );

    check(
      "file case mismatch fails",
      () => {
        write("README.md", "# Root\n");
        write("CONTRIBUTING.md", "# Contributing\n");
        write("SECURITY.md", "# Security\n");
        write("docs/page.md", "# Page\n\n[wrong case](Target.md)\n");
        write("docs/target.md", target);
      },
      1,
      ['missing link target "Target.md"'],
    );

    check(
      "anchor case mismatch fails",
      () => {
        write("README.md", "# Root\n");
        write("CONTRIBUTING.md", "# Contributing\n");
        write("SECURITY.md", "# Security\n");
        write("docs/page.md", "# Page\n\n[wrong case](target.md#Setup)\n");
        write("docs/target.md", target);
      },
      1,
      ['missing anchor "#Setup"'],
    );

    check(
      "links inside fenced code and inline code are skipped",
      () => {
        write("README.md", "# Root\n");
        write("CONTRIBUTING.md", "# Contributing\n");
        write("SECURITY.md", "# Security\n");
        write(
          "docs/page.md",
          [
            "# Page",
            "",
            "```md",
            "[fenced](missing.md)",
            "[fenced anchor](#no-such-anchor)",
            "# Not a heading",
            "```",
            "",
            "`[inline](missing.md)`",
            "",
            "[real](target.md)",
            "",
          ].join("\n"),
        );
        write("docs/target.md", target);
      },
      0,
    );

    check(
      "duplicate heading anchors resolve with suffixes",
      () => {
        write("README.md", "# Root\n");
        write("CONTRIBUTING.md", "# Contributing\n");
        write("SECURITY.md", "# Security\n");
        write(
          "docs/page.md",
          ["# Page", "", "[first](target.md#setup)", "[second](target.md#setup-1)"].join("\n"),
        );
        write("docs/target.md", target);
      },
      0,
    );

    check(
      "second duplicate suffix fails when only two headings exist",
      () => {
        write("README.md", "# Root\n");
        write("CONTRIBUTING.md", "# Contributing\n");
        write("SECURITY.md", "# Security\n");
        write("docs/page.md", "# Page\n\n[third](target.md#setup-2)\n");
        write("docs/target.md", target);
      },
      1,
      ['missing anchor "#setup-2"'],
    );

    check(
      "bare angle brackets are literal text in slugs",
      () => {
        write("README.md", "# Root\n");
        write("CONTRIBUTING.md", "# Contributing\n");
        write("SECURITY.md", "# Security\n");
        write("docs/page.md", ["# Page", "", "[budget](target.md#p95--300-ms-budget)"].join("\n"));
        write("docs/target.md", "# Target\n\n## p95 < 300 ms budget\n");
      },
      0,
    );

    assert.equal(slugifyHeading("Change-gated CI and `ci-ok`"), "change-gated-ci-and-ci-ok");
    assert.equal(
      slugifyHeading("Production cutover capability ↔ reverse map"),
      "production-cutover-capability--reverse-map",
    );
    assert.equal(slugifyHeading("Topology (target)"), "topology-target");
    assert.equal(slugifyHeading("p95 < 300 ms budget"), "p95--300-ms-budget");
    assert.equal(slugifyHeading("x <= y"), "x--y");
    assert.equal(slugifyHeading("Hello <code>world</code> done"), "hello-world-done");
    assert.ok(collectAnchors("```\n# Not a heading\n```\n## Real\n").has("real"));
    assert.ok(!collectAnchors("```\n# Not a heading\n```\n## Real\n").has("not-a-heading"));
    cases += 1;
    console.log("PASS heading slug unit cases");
    console.log(`doc links selftest: ${cases} cases passed.`);
    return 0;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length > 3 || (process.argv[2] && process.argv[2] !== "--selftest")) {
    console.error("Usage: node ci/check-doc-links.mjs [--selftest]");
    process.exitCode = 2;
  } else if (process.argv[2] === "--selftest") {
    process.exitCode = selftest();
  } else {
    process.exitCode = checkLinks(repoRoot);
  }
}
