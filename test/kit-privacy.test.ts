// Kit privacy port contract: GET /privacy renders from the
// shared POLICY_MARKDOWN/POLICY_VERSION source with zero duplication.
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { POLICY_MARKDOWN } from "../src/privacy-content";
import { POLICY_VERSION, renderPolicyMarkdown } from "../src/privacy";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const serverPath = join(root, "web/src/routes/privacy/+page.server.ts");
const pagePath = join(root, "web/src/routes/privacy/+page.svelte");
const manifestPath = join(root, "src/route-ownership.ts");

function read(p: string): string {
  return readFileSync(p, "utf8");
}

describe("Kit privacy port: single policy source", () => {
  it("imports the shared bundle, never a copied policy text", () => {
    const server = read(serverPath);
    expect(server).toContain("POLICY_MARKDOWN");
    expect(server).toContain("POLICY_VERSION");
    expect(server).toContain("renderPolicyMarkdown");
    // No divergent copy: the distinctive policy sentence lives only in
    // content/ + the generated bundle, never under web/.
    const needle = "Together We Own is an adult gaming community";
    const webHits: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (/\.(svelte|ts)$/.test(entry.name)) {
          if (read(path).includes(needle)) webHits.push(path);
        }
      }
    };
    walk(join(root, "web/src/routes/privacy"));
    expect(webHits).toEqual([]);
    expect(POLICY_VERSION).toBe(6);
    expect(POLICY_MARKDOWN.startsWith("## Who we are")).toBe(true);
  });

  it("performs no DB/session reads on the request path", () => {
    const server = read(serverPath);
    expect(server).not.toMatch(/dbFor|ADMIN_DB|SESSION_STORE|kitSessionBridge|memberRead/);
    expect(server).toContain("public, max-age=3600");
    expect(server).toContain("csr = false");
    // The leaf CSS reaches the page only through this load's data merge.
    expect(server).toContain("leafCss: LEAF_CRITICAL_CSS");
  });

  it("registers a public, Hono-owned manifest entry", () => {
    const manifest = read(manifestPath);
    expect(manifest).toMatch(/path:\s*"\/privacy"/);
    expect(manifest).toMatch(/\/privacy"[^}]*reads:\s*"public"/);
    // Stays on Hono until the enablement review: flipping enabled flips
    // ownership, and the parity ledger fails any enabled route with no run.
    expect(manifest).toMatch(/\/privacy"[^}]*enabled:\s*false/);
  });
});

describe("Kit privacy port: safe rendering and chrome", () => {
  it("renders version, policy testids, join/back links and content nav", () => {
    const page = read(pagePath);
    expect(page).toContain('data-testid="privacy-version"');
    expect(page).toContain('data-testid="privacy-policy"');
    expect(page).toContain('data-testid="privacy-join"');
    expect(page).toContain('href="/join"');
    expect(page).toContain('href="/"');
    expect(page).toContain('href="/about"');
    expect(page).toContain('href="/faq"');
    expect(page).toContain('href="/rules"');
    expect(page).toContain('href="/privacy"');
    expect(page).toContain('aria-current="page"');
    expect(page).toContain('id="privacy-heading"');
    expect(page).toContain('theme="content"');
    expect(page).toContain("<h1");
    expect(page).toContain("{@html");
    // Header keeps the Hono Leaf joinAction chrome: guest caption plus the
    // Join button, so the standard guest-chrome gate holds at enablement.
    expect(page).toContain("Welcome, guest");
    expect(page).toContain('class="account-caption"');
  });

  it("keeps canonical + markdown alternate metadata, no index change", () => {
    const page = read(pagePath);
    expect(page).toContain("canonical");
    expect(page).toContain("/privacy.md");
    expect(page).not.toContain('name="robots"');
  });

  it("ships no JavaScript on the page", () => {
    const page = read(pagePath);
    // The Svelte component <script lang> block is server-only (csr=false
    // below); the rendered HTML must carry no island or inline script.
    expect(page).not.toContain("<script src");
    expect(page).not.toContain("unsafe-inline");
    expect(page).not.toContain('src="/islands/');
  });

  it("reuses the safe renderer: hostile markdown escapes, links never form", () => {
    const hostile = renderPolicyMarkdown(
      '# Not an h1\n\n<script>alert("x")</script>\n\n[evil](https://evil.test)\n\n**unclosed\n',
    );
    expect(hostile).not.toContain("<script>");
    expect(hostile).toContain("&lt;script&gt;");
    expect(hostile).not.toContain("<h1>");
    expect(hostile).not.toContain("<a ");
    // The constructs the policy uses still render richly.
    const rich = renderPolicyMarkdown("## Title\n\nHello **bold** and `code`.\n");
    expect(rich).toContain('<h2 id="policy-title">Title</h2>');
    expect(rich).toContain("<strong>bold</strong>");
    expect(rich).toContain("<code>code</code>");
  });
});
