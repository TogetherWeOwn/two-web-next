import { existsSync, readFileSync } from "node:fs";
import { URL, fileURLToPath } from "node:url";
import { expect } from "vitest";

export const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
export const readRepo = (path: string) => readFileSync(new URL(path, `file://${repoRoot}`), "utf8");

export function markdownLinks(text: string): string[] {
  return [...text.matchAll(/\[[^\]]+\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g)].map((m) => m[1]!);
}

// Discover the guide from the public index instead of prescribing its filename.
// A missing deliverable is an assertion failure, never a module-load ENOENT.
export function recoveryGuide() {
  const index = readRepo("README.md");
  const candidates = [
    ...index.matchAll(/\[([^\]]*RSVP[^\]]*)\]\((docs\/[^\s)]+\.md)(?:#[^)]*)?\)/gi),
  ];
  expect(candidates, "README indexes one focused member RSVP recovery guide").toHaveLength(1);
  const path = candidates[0]![2]!;
  expect(existsSync(new URL(path, `file://${repoRoot}`)), `indexed guide exists: ${path}`).toBe(
    true,
  );
  return { path, body: readRepo(path) };
}

function isTagNameChar(ch: string): boolean {
  return (ch >= "0" && ch <= "9") || (ch >= "A" && ch <= "Z") || (ch >= "a" && ch <= "z");
}

function isHtmlSpace(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\f" || ch === "\r";
}

// Scan a tag starting at the "<" at index `start`. Returns the index just
// past the closing ">", the lowercased tag name and whether it closes, or
// null when there is no well-formed tag here (a stray "<" stays text).
// Quoted attribute values may contain ">".
function scanTag(
  html: string,
  start: number,
): { end: number; name: string; closing: boolean } | null {
  let i = start + 1;
  let closing = false;
  if (html.charAt(i) === "/") {
    closing = true;
    i++;
  }
  if (closing) {
    while (isHtmlSpace(html.charAt(i))) i++;
  }
  const nameStart = i;
  while (isTagNameChar(html.charAt(i))) i++;
  if (i === nameStart) return null;
  const name = html.slice(nameStart, i).toLowerCase();
  let quote = "";
  while (i < html.length) {
    const ch = html.charAt(i);
    if (quote) {
      if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === ">") {
      return { end: i + 1, name, closing };
    }
    i++;
  }
  return null;
}

// Find the index just past the closing tag for `name` at or after `from`,
// tolerating whitespace and case inside the closer ("</script >", "</SCRIPT>").
// Returns -1 when the element never closes.
function scanClosingTag(html: string, from: number, name: string): number {
  let i = from;
  while (i < html.length) {
    const next = html.indexOf("<", i);
    if (next === -1) return -1;
    const tag = scanTag(html, next);
    if (tag?.closing && tag.name === name) return tag.end;
    i = next + 1;
  }
  return -1;
}

// Visible-text extraction as a single-pass token scan: tags, comments and
// declarations become one space, script/style bodies are skipped through
// their closer, and anything else (including a stray "<") stays text.
export function htmlText(html: string) {
  const parts: string[] = [];
  let i = 0;
  while (i < html.length) {
    if (html.startsWith("<!--", i)) {
      const end = html.indexOf("-->", i + 4);
      i = end === -1 ? html.length : end + 3;
      parts.push(" ");
      continue;
    }
    if (html.charAt(i) === "<" && (html.charAt(i + 1) === "!" || html.charAt(i + 1) === "?")) {
      const end = html.indexOf(">", i + 2);
      i = end === -1 ? html.length : end + 1;
      parts.push(" ");
      continue;
    }
    if (html.charAt(i) === "<") {
      const tag = scanTag(html, i);
      if (!tag) {
        parts.push("<");
        i++;
        continue;
      }
      if (!tag.closing && (tag.name === "script" || tag.name === "style")) {
        const end = scanClosingTag(html, tag.end, tag.name);
        i = end === -1 ? html.length : end;
      } else {
        i = tag.end;
      }
      parts.push(" ");
      continue;
    }
    parts.push(html.charAt(i));
    i++;
  }
  return parts
    .join("")
    .replaceAll("&#x27;", "'")
    .replaceAll("&#39;", "'")
    .replaceAll("&apos;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&amp;", "&")
    .replace(/\s+/g, " ")
    .trim();
}

export function htmlLinks(html: string): string[] {
  return [...html.matchAll(/<a\b[^>]*\bhref="([^"]+)"/g)].map((m) => m[1]!.replace(/&amp;/g, "&"));
}

export function publicGuidePath(href: string): string | null {
  const match =
    /^https:\/\/github\.com\/TogetherWeOwn\/two-web-next\/blob\/(?:main|[0-9a-f]{40})\/(docs\/[^?#]+\.md)(?:#.*)?$/.exec(
      href,
    );
  return match?.[1] ?? null;
}

// Allow a decision tree made of headings or table rows. Keep each instruction
// local to its outcome: a warning in an unrelated branch cannot satisfy it.
// Branch locality: the outcome must match the block heading (or first line)
// only, Source-references is never a branch, and exactly one block must match.
export function guidanceFor(body: string, outcome: RegExp): string {
  const sections = body.split(/(?=^#{1,6} )/m).filter((section) => {
    const heading = section.split("\n")[0] ?? "";
    return !/source.references/i.test(heading);
  });
  const blocks = sections.flatMap((section) => {
    const rows = section.split("\n").filter((line) => /^\|/.test(line));
    return rows.length ? [section.split(/^\|/m)[0]!, ...rows] : [section];
  });
  const matchTarget = (block: string): string => {
    const lines = block.split("\n");
    const first = lines[0] ?? "";
    if (/^\|/.test(first.trim())) return first;
    if (/^#{1,6} /.test(first)) {
      const content = lines.slice(1).find((line) => line.trim().length > 0) ?? "";
      return `${first}\n${content}`;
    }
    return first;
  };
  const matches = blocks.filter((block) => {
    outcome.lastIndex = 0;
    return outcome.test(matchTarget(block));
  });
  expect(matches.length, `recovery branch for ${outcome}`).toBe(1);
  return matches[0]!.replace(/[*_`]/g, "").replace(/\s+/g, " ");
}
