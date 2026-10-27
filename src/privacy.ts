// Versioned privacy policy (N1: TOG-9893). Ports two-web PrivacyController,
// which reads content/privacy-policy-v1.md from disk (POLICY_VERSION=1) via
// Str::markdown behind routes/funnel.php's empty middleware stack.
//
// Workers have no disk at runtime, so the repo markdown file is the live
// source and src/privacy-content.ts is its generated bundle copy. A version
// bump = new content/privacy-policy-vN.md file + repoint POLICY_FILE /
// POLICY_VERSION below + regen the bundle (command at the top of
// src/privacy-content.ts).
//
// renderPolicyMarkdown covers exactly the constructs v1 uses: ## headings,
// paragraphs, `code`, **bold**, and - list items with wrapped continuation
// lines. Anything else passes through as plain paragraph text (escaped), so
// a future version using new syntax renders safely, not richly.
//
// Section navigation: the `## ` headings are the single section authority.
// policySections derives the fragment ids from them, and renderPolicyMarkdown
// uses the same list for the heading ids, so the jump list and the permalinks
// can never drift from the policy text. Presentation only: the policy words,
// the published files and /privacy.md are untouched.

export const POLICY_FILE = "content/privacy-policy-v6.md";
export const POLICY_VERSION = 6;

const escapeHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export type PolicySection = { id: string; title: string };

/** The title of a `## ` heading line, or null for any other line. */
const headingTitle = (line: string): string | null =>
  line.startsWith("## ") ? line.slice(3).trim() : null;

/**
 * Deterministic, unique fragment ids for the `## ` sections in document order:
 * a fixed prefix (clear of the page's own ids) plus a lowercase ASCII slug of
 * the title. Repeated titles get -2, -3, … suffixes, skipping any id in use.
 */
export function policySections(markdown: string): PolicySection[] {
  const taken = new Set<string>();
  const sections: PolicySection[] = [];
  for (const line of markdown.split("\n")) {
    const title = headingTitle(line);
    if (title === null) continue;
    const base = `policy-${title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-/, "")
      .slice(0, 60)
      .replace(/-$/, "")}`;
    let id = base;
    for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
    taken.add(id);
    sections.push({ id, title });
  }
  return sections;
}

// Inline code spans are rendered before bold, per segment, so ** inside
// backticks (none in v1) can never become markup.
function renderInline(src: string): string {
  return src
    .split("`")
    .map((segment, i) =>
      i % 2 === 1
        ? `<code>${escapeHtml(segment)}</code>`
        : escapeHtml(segment).replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>"),
    )
    .join("");
}

function renderListItem(src: string): string {
  return `<li>${renderInline(src)}</li>`;
}

/**
 * Minimal CommonMark-equivalent for the v1 policy constructs. Output is fully
 * escaped HTML. Every heading carries its policySections id; `navigation`
 * additionally prepends the native jump list and adds a permalink to each
 * heading (the member-facing pages), so the default stays link-free.
 */
export function renderPolicyMarkdown(
  markdown: string,
  { navigation = false }: { navigation?: boolean } = {},
): string {
  const sections = policySections(markdown);
  let heading = 0;
  const blocks: string[] = [];
  if (navigation && sections.length > 0) {
    blocks.push(
      `<nav aria-label="Jump to a policy section" data-testid="privacy-jump">\n<p class="strap">Jump to a section</p>\n<ul class="jump">\n${sections
        .map(({ id, title }) => `<li><a href="#${id}">${renderInline(title)}</a></li>`)
        .join("\n")}\n</ul>\n</nav>`,
    );
  }
  let paragraph: string[] = [];
  let list: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length > 0) {
      blocks.push(`<p>${renderInline(paragraph.join("\n"))}</p>`);
      paragraph = [];
    }
  };
  const flushList = () => {
    if (list.length > 0) {
      blocks.push(`<ul>\n${list.map(renderListItem).join("\n")}\n</ul>`);
      list = [];
    }
  };

  for (const line of markdown.split("\n")) {
    if (line.trim() === "") {
      flushParagraph();
      flushList();
    } else if (headingTitle(line) !== null) {
      flushParagraph();
      flushList();
      const { id, title } = sections[heading++]!;
      const permalink = navigation
        ? ` <a href="#${id}" aria-label="Permalink to section: ${escapeHtml(title)}">#</a>`
        : "";
      blocks.push(`<h2 id="${id}">${renderInline(title)}${permalink}</h2>`);
    } else if (line.startsWith("- ")) {
      flushParagraph();
      list.push(line.slice(2).trim());
    } else if (list.length > 0 && (line.startsWith("  ") || line.startsWith("\t"))) {
      // Wrapped continuation of the current list item (v1 wraps at ~80 cols).
      list[list.length - 1] += ` ${line.trim()}`;
    } else {
      flushList();
      paragraph.push(line.trim());
    }
  }
  flushParagraph();
  flushList();
  return `${blocks.join("\n")}\n`;
}
