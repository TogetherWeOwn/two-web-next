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
  it("renders v3 with zero queries: 200 with the app DB down, no cookies, CSP present", async () => {
    const res = await app.request("/privacy", {}, noDbEnv);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(res.headers.get("cache-control")).toBe("public, max-age=3600");
    expect(res.headers.getSetCookie()).toHaveLength(0);
    const html = await res.text();
    expect(html).toContain('data-testid="privacy-version"');
    expect(html).toContain("Version 3");
    expect(html).toContain('data-testid="privacy-policy"');
    expect(html).toContain("<h2>What we store</h2>");
    expect(html).toContain("<strong>Your Discord identity</strong>");
    expect(html).toContain("<code>identify</code>");
    expect(html).toContain("<code>guilds.join</code>");
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
    expect(await res.text()).toContain("Version 3");
  });

  it("appears in the sitemap crawl set at 0.7 (parity matrix §1)", async () => {
    const xml = await (await app.request("/sitemap_index.xml", {}, env)).text();
    expect(xml).toContain("<loc>https://next.example.test/privacy</loc>");
  });
});

describe("policy versioning contract", () => {
  it("pins version 3 to the v3 content file and keeps v1/v2 in history", () => {
    expect(POLICY_VERSION).toBe(3);
    expect(POLICY_FILE).toBe("content/privacy-policy-v3.md");
    expect(POLICY_MARKDOWN.startsWith("## Who we are")).toBe(true);
    expect(existsSync(resolve(root, "content/privacy-policy-v1.md"))).toBe(true);
    expect(existsSync(resolve(root, "content/privacy-policy-v2.md"))).toBe(true);
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

describe("policy v3 discloses the Discord bot's records", () => {
  const flat = POLICY_MARKDOWN.replace(/\s+/g, " ");
  const section = (heading: string): string => {
    const start = POLICY_MARKDOWN.indexOf(`## ${heading}\n`);
    expect(start, `missing section "${heading}"`).toBeGreaterThanOrEqual(0);
    const next = POLICY_MARKDOWN.indexOf("\n## ", start + 1);
    return POLICY_MARKDOWN.slice(start, next === -1 ? undefined : next).replace(/\s+/g, " ");
  };

  it("names each category of bot record", () => {
    const bot = section("What the Discord bot keeps");
    for (const category of [
      "**Membership and invites**",
      "**Levels and ranks**",
      "**Events and RSVPs**",
      "**Moderation and safety**",
      "**Support tickets**",
      "**Voice rooms**",
      "**Posts and sign-ups**",
      "**Audit trail**",
    ]) {
      expect(bot, category).toContain(category);
    }
  });

  it("says message text and online status are read only when a feature needs them", () => {
    const why = section("Why the bot asks Discord for sensitive data");
    expect(why).toContain("only when a feature that needs it is switched on");
    expect(why).toContain("Message content");
    expect(why).toContain("Online status");
    expect(why).toContain("never receives or stores voice audio");
  });

  it("gives the reason for each sensitive Discord permission", () => {
    const why = section("Why the bot asks Discord for sensitive data");
    for (const scope of [
      "Member list",
      "Message content",
      "Online status",
      "Moderation log",
      "Invites",
    ]) {
      expect(why, scope).toContain(`**${scope}**`);
    }
  });

  it("states retention truthfully: no timer for most bot records, 90 days for ticket transcripts", () => {
    const bot = section("What the Discord bot keeps");
    expect(bot).toContain("Most bot records have no automatic deletion timer");
    expect(bot).toContain(
      "Support-ticket transcripts are kept for 90 days after they are saved, then deleted",
    );
    expect(flat).not.toMatch(/automatically (?:deleted|removed|purged|expired)/i);
  });

  it("does not claim an opt-out switch or suppression exists yet", () => {
    expect(flat).toContain("There is no opt-out switch yet");
    expect(flat).not.toMatch(
      /\/privacy opt-out|opt-out command|self-serve opt|opt out at any time/i,
    );
  });

  it("commits to no sale, licensing, advertising or data-broker transfer", () => {
    const sharing = section("Selling and sharing");
    expect(sharing).toContain("We do not sell, license or commercialize");
    expect(sharing).toContain("advertising networks, data brokers or monetization services");
  });

  it("names the request intake and the limits of a deletion", () => {
    const del = section("Deletion");
    expect(del).toContain("DM a moderator or open a private support ticket in our server");
    expect(del).toContain("our server only");
    expect(del).toContain("backup copies");
    expect(del).toContain("access log");
    expect(del).toContain("moderator edit history");
    expect(del).toContain("settings history");
    expect(del).toContain("deletion receipt");
  });

  it("keeps internal tracker IDs, repository and agent names out of the public text", () => {
    expect(POLICY_MARKDOWN).not.toMatch(
      /TOG-|PAP-|Paperclip|two-bot|two-web|CISO|agent-|https?:\/\//,
    );
  });

  it("keeps the FAQ's storage answer consistent with the policy", async () => {
    const html = await (await app.request("/faq", {}, noDbEnv)).text();
    expect(html).not.toContain("We never store message content");
    expect(html).toContain('href="/privacy"');
  });
});
