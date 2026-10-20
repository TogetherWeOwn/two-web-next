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

export function htmlText(html: string) {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&#x27;|&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
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
export function guidanceFor(body: string, outcome: RegExp): string {
  const blocks = body.split(/(?=^#{1,6} )/m).flatMap((section) => {
    const rows = section.split("\n").filter((line) => /^\|/.test(line));
    return rows.length ? [section.split(/^\|/m)[0]!, ...rows] : [section];
  });
  const matches = blocks.filter((block) => outcome.test(block));
  expect(matches.length, `recovery branch for ${outcome}`).toBeGreaterThan(0);
  return matches.join("\n").replace(/[*_`]/g, "").replace(/\s+/g, " ");
}
