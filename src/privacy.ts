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

export const POLICY_FILE = "content/privacy-policy-v2.md";
export const POLICY_VERSION = 2;

const escapeHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

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

/** Minimal CommonMark-equivalent for the v1 policy constructs. Output is fully escaped HTML. */
export function renderPolicyMarkdown(markdown: string): string {
  const blocks: string[] = [];
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
    } else if (line.startsWith("## ")) {
      flushParagraph();
      flushList();
      blocks.push(`<h2>${renderInline(line.slice(3).trim())}</h2>`);
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
