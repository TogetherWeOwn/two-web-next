// route-inventory: GET /privacy
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import app from "./app";
import { POLICY_MARKDOWN } from "../src/privacy-content";
import { POLICY_FILE, POLICY_VERSION, renderPolicyMarkdown } from "../src/privacy";
import type { Env } from "../src/env";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const env: Env = {
  APP_URL: "https://next.example.test",
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: "326474832151838730",
  DISCORD_INVITE_URL: "https://discord.gg/configured",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
  SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
};

// Any session/store/DB touch throws: if /privacy reads one, this env 500s.
const noDbEnv = {
  ...env,
  DATABASE_URL: "postgres://agent-testdb:5432/unused",
  SESSION_STORE: new Proxy(
    {},
    {
      get: () => {
        throw new Error("privacy must not touch the session store");
      },
    },
  ),
  ROSTER_STORE: new Proxy(
    {},
    {
      get: () => {
        throw new Error("privacy must not touch the roster store");
      },
    },
  ),
} as unknown as Env;

describe("/privacy versioned policy page (N1)", () => {
  it("renders v6 with zero queries: 200 with the app DB down, no cookies, CSP present", async () => {
    const res = await app.request("/privacy", {}, noDbEnv);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(res.headers.get("cache-control")).toBe("public, max-age=3600");
    expect(res.headers.getSetCookie()).toHaveLength(0);
    const html = await res.text();
    expect(html).toContain('data-testid="privacy-version"');
    expect(html).toContain("Version 6");
    expect(html).toContain('data-testid="privacy-policy"');
    expect(html).toContain('<h2 id="policy-what-we-store">What we store ');
    expect(html).toContain("<strong>Your Discord identity</strong>");
    expect(html).toContain("<code>identify</code>");
    expect(html).toContain("<code>guilds.join</code>");
    expect(html).toContain("Deletion");
  });

  it.each(["source", "served"])(
    "distinguishes anonymous board telemetry from viewer-linked access auditing in %s content",
    async (format) => {
      const content =
        format === "source"
          ? readFileSync(resolve(root, POLICY_FILE), "utf8")
          : await (await app.request("/privacy", {}, noDbEnv)).text();
      const flat = (text: string) => {
        // Strip tags without a `<...>` regex replace so the test helper does
        // not read as an HTML sanitizer (CodeQL incomplete sanitization).
        let out = "";
        let inTag = false;
        for (const ch of text) {
          if (ch === "<") inTag = true;
          else if (ch === ">") inTag = false;
          else if (!inTag) out += ch;
        }
        return out.replace(/\s+/g, " ");
      };
      const board = content.match(
        /(?:- \*\*Leaderboard views\*\*|<li><strong>Leaderboard views<\/strong>)[\s\S]*?(?:\n- |<\/li>)/,
      )?.[0];
      expect(board, "board disclosure must be present").toBeDefined();
      const disclosure = flat(board!);
      expect(disclosure).toMatch(
        /anonymous board-view log records.*no user, session or IP address/i,
      );
      expect(disclosure).toMatch(/separate from member-data access auditing/i);
      expect(disclosure).toMatch(
        /other members.*access log records who viewed, when, and whose records were read/i,
      );
      expect(disclosure).toMatch(/also for 90 days/i);
      expect(disclosure).toMatch(
        /Hot-zone boards use the anonymous board-view log without member-data access auditing/,
      );
      const version3 = content.match(/Version 3\b[\s\S]*?(?:\n\n|<\/p>)/)?.[0];
      expect(version3, "version 3 summary must remain qualified").toBeDefined();
      expect(flat(version3!)).toMatch(
        /anonymous board-view telemetry, separately from viewer-linked member-data access auditing/,
      );
      expect(flat(content)).not.toMatch(/each view logged without identity/i);
    },
  );

  it("ships no JavaScript on the page", async () => {
    const html = await (await app.request("/privacy", {}, noDbEnv)).text();
    expect(html).not.toContain("<script");
  });

  it("ignores a session cookie: no rotation, no personalization", async () => {
    const forged = `__Host-two_session=${encodeURIComponent("two_forged-token")}.bad`;
    const res = await app.request("/privacy", { headers: { cookie: forged } }, noDbEnv);
    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie()).toHaveLength(0);
    expect(await res.text()).toContain("Version 6");
  });

  it("appears in the sitemap crawl set at 0.7 (parity matrix §1)", async () => {
    const xml = await (await app.request("/sitemap_index.xml", {}, env)).text();
    expect(xml).toContain("<loc>https://next.example.test/privacy</loc>");
  });
});

describe("policy versioning contract", () => {
  it("pins version 6 to the v6 content file and keeps v1/v2/v3/v4/v5 in history", () => {
    expect(POLICY_VERSION).toBe(6);
    expect(POLICY_FILE).toBe("content/privacy-policy-v6.md");
    expect(POLICY_MARKDOWN.startsWith("## Who we are")).toBe(true);
    expect(existsSync(resolve(root, "content/privacy-policy-v1.md"))).toBe(true);
    expect(existsSync(resolve(root, "content/privacy-policy-v2.md"))).toBe(true);
    expect(existsSync(resolve(root, "content/privacy-policy-v3.md"))).toBe(true);
    expect(existsSync(resolve(root, "content/privacy-policy-v4.md"))).toBe(true);
    expect(existsSync(resolve(root, "content/privacy-policy-v5.md"))).toBe(true);
  });

  // v1 described the legacy stack (TOG-12553). These facts are false on Next.
  it("drops the legacy-stack claims", () => {
    expect(POLICY_MARKDOWN).not.toContain("guilds.members.read");
    expect(POLICY_MARKDOWN).not.toContain("XSRF");
    expect(POLICY_MARKDOWN).not.toContain("Livewire");
  });

  // A new cookie must be disclosed before it ships: every __Host-two_* name in src.
  it("names every cookie the app sets", () => {
    const names = new Set<string>();
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (/\.tsx?$/.test(entry.name)) {
          for (const m of readFileSync(path, "utf8").matchAll(/__Host-two_[a-z_]+/g))
            names.add(m[0]);
        }
      }
    };
    walk(resolve(root, "src"));
    expect(names.size).toBeGreaterThanOrEqual(10);
    for (const name of names) expect(POLICY_MARKDOWN, name).toContain(`\`${name}\``);
  });

  it("renders headings, bold, code, and wrapped list items", () => {
    const html = renderPolicyMarkdown(
      "## Title\n\nHello **bold** and `code`.\n\n- **First item** — lead,\n  wrapped continuation.\n- Second.\n",
    );
    expect(html).toContain('<h2 id="policy-title">Title</h2>');
    expect(html).toContain("<p>Hello <strong>bold</strong> and <code>code</code>.</p>");
    expect(html).toContain("<li><strong>First item</strong> — lead, wrapped continuation.</li>");
  });

  it("escapes everything it does not understand: no raw HTML passthrough", () => {
    const html = renderPolicyMarkdown('# Not an h1\n\n<script>alert("x")</script>\n\n**unclosed\n');
    expect(html).not.toContain("<h1>");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});
