// route-inventory: GET /privacy
import { describe, expect, it } from "vitest";
import app from "./app";
import { POLICY_MARKDOWN } from "../src/privacy-content";
import { POLICY_FILE, POLICY_VERSION, renderPolicyMarkdown } from "../src/privacy";
import type { Env } from "../src/env";

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
  it("renders v1 with zero queries: 200 with the app DB down, no cookies, CSP present", async () => {
    const res = await app.request("/privacy", {}, noDbEnv);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(res.headers.get("cache-control")).toBe("public, max-age=3600");
    expect(res.headers.getSetCookie()).toHaveLength(0);
    const html = await res.text();
    expect(html).toContain('data-testid="privacy-version"');
    expect(html).toContain("Version 1");
    expect(html).toContain('data-testid="privacy-policy"');
    expect(html).toContain("<h2>What we store</h2>");
    expect(html).toContain("<strong>Your Discord identity</strong>");
    expect(html).toContain("<code>identify</code>");
    expect(html).toContain("<code>guilds.members.read</code>");
    expect(html).toContain("Deletion");
  });

  it("ships no JavaScript on the page", async () => {
    const html = await (await app.request("/privacy", {}, noDbEnv)).text();
    expect(html).not.toContain("<script");
  });

  it("ignores a session cookie: no rotation, no personalization", async () => {
    const forged = `__Host-two_session=${encodeURIComponent("two_forged-token")}.bad`;
    const res = await app.request("/privacy", { headers: { cookie: forged } }, noDbEnv);
    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie()).toHaveLength(0);
    expect(await res.text()).toContain("Version 1");
  });

  it("appears in the sitemap crawl set at 0.7 (parity matrix §1)", async () => {
    const xml = await (await app.request("/sitemap_index.xml", {}, env)).text();
    expect(xml).toContain("<loc>https://next.example.test/privacy</loc>");
  });
});

describe("policy versioning contract", () => {
  it("pins version 1 to the v1 content file", () => {
    expect(POLICY_VERSION).toBe(1);
    expect(POLICY_FILE).toBe("content/privacy-policy-v1.md");
    expect(POLICY_MARKDOWN.startsWith("## Who we are")).toBe(true);
  });

  it("renders headings, bold, code, and wrapped list items", () => {
    const html = renderPolicyMarkdown(
      "## Title\n\nHello **bold** and `code`.\n\n- **First item** — lead,\n  wrapped continuation.\n- Second.\n",
    );
    expect(html).toContain("<h2>Title</h2>");
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
