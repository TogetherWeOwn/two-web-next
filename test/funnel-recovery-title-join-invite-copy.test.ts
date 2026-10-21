// route-inventory: GET /join
// route-inventory: GET /join/callback
// route-inventory: GET /auth/recover
// Acceptance fixtures for `funnel: fix Recovery title, join invite fallback,
// and shared result copy` (roadmap D6), owned by the acceptance card. The
// Builder builds on this branch and never edits this file; corrections return
// to the Test Author. Failing-first: the title, invite and single-source pins
// below run RED against the current implementation, while the ErrorShell,
// byte-equality and no-tsx guards already pass and must stay green.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { URL as NodeURL, fileURLToPath } from "node:url";
import { Hono } from "hono";
import { serializeSigned } from "hono/utils/cookie";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "./app";
import type { Env } from "../src/env";
import { renderHtmlOutcome } from "../src/html-outcome";
import { HOME_JOIN_RESULT_COPY } from "../src/home-copy";
import { FALLBACK_INVITE, inviteDestination } from "../src/invite";
import { kitErrorCopy, type KitErrorStatus } from "../src/kit-errors";
import { honoRecoveryRenderer } from "../src/recovery-hono";
import { recoveryOutcome, type RecoveryModel } from "../src/recovery-outcome";
import { JOIN_RESULT_COOKIE } from "../src/return-journey";

const SITE_SUFFIX = "— Together We Own";

// The join intro sentence, pinned verbatim: the move to home-copy.ts must not
// rewrite a word of it (the Kit drift pins below quote the same literal).
const JOIN_INTRO_SENTENCE = "Approve once with Discord and we will add you to the server.";

const env: Env = {
  APP_URL: "https://next.example.test",
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: "326474832151838730",
  DISCORD_INVITE_URL: FALLBACK_INVITE,
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
  SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
};

const recoveryLib = readFileSync(
  new NodeURL("../web/src/lib/Recovery.svelte", import.meta.url),
  "utf8",
);
const siteMetadata = readFileSync(
  new NodeURL("../web/src/lib/SiteMetadata.svelte", import.meta.url),
  "utf8",
);
const errorShellLib = readFileSync(
  new NodeURL("../web/src/lib/ErrorShell.svelte", import.meta.url),
  "utf8",
);
const joinPage = readFileSync(
  new NodeURL("../web/src/routes/join/+page.svelte", import.meta.url),
  "utf8",
);
const joinLoad = readFileSync(
  new NodeURL("../web/src/routes/join/+page.server.ts", import.meta.url),
  "utf8",
);
const joinRoutePage = readFileSync(
  new NodeURL("../src/join/route-page.ts", import.meta.url),
  "utf8",
);
const joinScreen = readFileSync(new NodeURL("../src/screens/join.tsx", import.meta.url), "utf8");
const homeCopy = readFileSync(new NodeURL("../src/home-copy.ts", import.meta.url), "utf8");
const errorPages = readFileSync(new NodeURL("../src/error-pages.tsx", import.meta.url), "utf8");

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function tabTitle(html: string): string {
  const match = /<title>([^<]*)<\/title>/.exec(html);
  if (!match?.[1]) throw new Error("expected a tab title in the rendered HTML");
  return match[1];
}

function suffixCount(title: string): number {
  return title.split(SITE_SUFFIX).length - 1;
}

function joinInviteHref(html: string): string | null {
  const match =
    /<a\s+href="([^"]*)"\s+data-testid="join-invite">/.exec(html) ??
    /<a\s+data-testid="join-invite"[^>]*href="([^"]*)">/.exec(html);
  return (match?.[1] ?? null)?.replaceAll("&amp;", "&") ?? null;
}

/** Hono escapes text nodes (`'` → `&#39;`): compare copy after unescaping. */
function unescapeHtml(html: string): string {
  return html.replaceAll("&#39;", "'").replaceAll("&quot;", '"').replaceAll("&amp;", "&");
}

async function renderHonoRecovery(model: RecoveryModel): Promise<string> {
  const f = new Hono<{ Bindings: Env }>();
  f.get("/recover", (c) => renderHtmlOutcome(c, recoveryOutcome(model, honoRecoveryRenderer)));
  const res = await f.request("/recover", {}, env);
  expect(res.status).toBe(200);
  return res.text();
}

/** The opening `<Shell …>` tag of a Svelte lib file. */
function shellTag(source: string): string {
  const start = source.indexOf("<Shell");
  if (start < 0) throw new Error("expected a <Shell> invocation");
  const end = source.indexOf(">", start);
  if (end < 0) throw new Error("expected the <Shell> tag to close");
  return source.slice(start, end + 1);
}

/** The value of one Svelte prop inside a `<Shell …>` tag, string or expression. */
function shellProp(tag: string, name: string): string | null {
  const quoted = new RegExp(`${name}="([^"]*)"`).exec(tag)?.[1];
  if (quoted !== undefined) return quoted;
  return new RegExp(`${name}=\\{([^}]*)\\}`).exec(tag)?.[1] ?? null;
}

/**
 * The tab title the Kit Recovery shell would render for a model title: the
 * SiteMetadata rule (exactTitle verbatim, else `${title} — site`) applied to
 * the props Recovery.svelte passes. A pre-suffixed title prop double-suffixes.
 */
function kitRecoveryTitleFor(modelTitle: string): string {
  const tag = shellTag(recoveryLib);
  if (tag.includes("exactTitle")) return `${modelTitle} ${SITE_SUFFIX}`;
  const titleProp = shellProp(tag, "title") ?? "";
  if (titleProp.includes("Together We Own")) return `${modelTitle} ${SITE_SUFFIX} ${SITE_SUFFIX}`;
  return `${modelTitle} ${SITE_SUFFIX}`;
}

const repoRoot = dirname(fileURLToPath(import.meta.url));

function kitSources(): Array<{ path: string; source: string }> {
  const out: Array<{ path: string; source: string }> = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else if (entry.isFile() && /\.(svelte|ts)$/.test(entry.name)) {
        out.push({ path, source: readFileSync(path, "utf8") });
      }
    }
  };
  walk(join(repoRoot, "..", "web", "src"));
  return out;
}

async function signedFlashCookie(result: "added" | "already_member"): Promise<string> {
  return (
    await serializeSigned(JOIN_RESULT_COOKIE, result, env.SESSION_SECRET, {
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "Lax",
    })
  ).split(";")[0]!;
}

describe("Hono Recovery titles suffix once and carry no share tags", () => {
  const model: RecoveryModel = {
    title: "Your session expired",
    message: "Sign in again, then review and submit them when you are ready.",
    retryUrl: "/auth/discord?next=%2Fprofile",
    retryLabel: "Log in with Discord",
    inviteUrl: "/discord",
  };

  it("renders the tab title with exactly one site suffix", async () => {
    const title = tabTitle(await renderHonoRecovery(model));
    expect(title).toBe(`Your session expired ${SITE_SUFFIX}`);
    expect(suffixCount(title)).toBe(1);
  });

  it("emits no og:title or twitter:title on the transient recovery page", async () => {
    const html = await renderHonoRecovery(model);
    expect(html).not.toContain("og:title");
    expect(html).not.toContain("twitter:title");
  });
});

describe("Kit Recovery titles match Hono byte-for-byte", () => {
  const model: RecoveryModel = {
    title: "Join cancelled",
    message: "You cancelled the Discord approval, so we couldn't add you to the server.",
    retryUrl: "/join/discord",
    retryLabel: "Try again",
    inviteUrl: FALLBACK_INVITE,
  };

  it("passes a bare title to Shell instead of a pre-suffixed one", () => {
    const titleProp = shellProp(shellTag(recoveryLib), "title");
    expect(titleProp, "Recovery.svelte <Shell> title prop").not.toBeNull();
    expect(titleProp ?? "").not.toContain("Together We Own");
  });

  it("renders through a bare title or an exactTitle, never a pre-suffixed title", () => {
    const tag = shellTag(recoveryLib);
    const titleProp = shellProp(tag, "title") ?? "";
    const exactProp = shellProp(tag, "exactTitle");
    expect(titleProp.includes("Together We Own") && exactProp === null).toBe(false);
    expect(titleProp === "title" || exactProp !== null).toBe(true);
    if (exactProp !== null) {
      // An exactTitle renders verbatim, so it must carry the suffix exactly once.
      expect(exactProp.split("Together We Own").length - 1).toBe(1);
    }
  });

  it("derives the same tab bytes Hono renders for the same model", async () => {
    const honoTitle = tabTitle(await renderHonoRecovery(model));
    expect(honoTitle).toBe(`Join cancelled ${SITE_SUFFIX}`);
    expect(kitRecoveryTitleFor(model.title)).toBe(honoTitle);
  });

  it("derives the suffix exactly once for every recovery title", async () => {
    for (const title of ["Join cancelled", "Join link expired", "Your session expired"]) {
      const honoTitle = tabTitle(await renderHonoRecovery({ ...model, title }));
      expect(suffixCount(honoTitle)).toBe(1);
      expect(suffixCount(kitRecoveryTitleFor(title))).toBe(1);
    }
  });

  it("adds no canonical or share title, matching Hono's absent share tags", () => {
    const tag = shellTag(recoveryLib);
    expect(tag).not.toContain("canonical");
    expect(tag).not.toContain("shareTitle");
  });
});

describe("ErrorShell titles stay exactly as they are", () => {
  const statuses: KitErrorStatus[] = [400, 404, 403, 410, 429, 500, 503];

  it("renders the Hono 404 with a single suffix", async () => {
    const res = await app.request("/this-page-does-not-exist-34800", {}, env);
    expect(res.status).toBe(404);
    const title = tabTitle(await res.text());
    expect(title).toBe(`We cannot find that page ${SITE_SUFFIX}`);
    expect(suffixCount(title)).toBe(1);
  });

  it("keeps every Kit error title identical to its Hono ErrorShell title", () => {
    for (const status of statuses) {
      expect(errorPages, `Hono title for ${status}`).toContain(
        `title="${kitErrorCopy(status).title}"`,
      );
    }
  });

  it("keeps the Kit ErrorShell on a bare copy.title through Shell", () => {
    const tag = shellTag(errorShellLib);
    expect(shellProp(tag, "title")).toBe("copy.title");
    expect(tag).not.toContain("Together We Own");
  });

  it("leaves the shared SiteMetadata suffix derivation untouched", () => {
    expect(siteMetadata).toContain("`${title} — ${SITE_NAME}`");
  });
});

describe("Hono /join degrades a bad invite to the hardcoded fallback", () => {
  const hostile = [
    "",
    "not a URL",
    "javascript:alert(1)",
    "https://evil.test/Ab12",
    "//discord.gg/Ab12",
    "/relative/path",
    "http://discord.gg/Ab12",
    "https://discord.gg/Ab12/extra",
    "https://discord.com/login",
  ];

  it.each(hostile)("renders the fallback, never the raw value: %s", async (configured) => {
    const network = vi.fn(() => {
      throw new Error("invite fallback must not call Discord");
    });
    vi.stubGlobal("fetch", network);
    const res = await app.request("/join", {}, { ...env, DISCORD_INVITE_URL: configured });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(joinInviteHref(html)).toBe(FALLBACK_INVITE);
    if (configured) expect(html).not.toContain(configured);
    expect(network).not.toHaveBeenCalled();
  });

  it("normalizes a usable invite instead of echoing it raw", async () => {
    const configured = "https://DISCORD.GG/Ab12";
    const res = await app.request("/join", {}, { ...env, DISCORD_INVITE_URL: configured });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(joinInviteHref(html)).toBe(inviteDestination(configured));
    expect(joinInviteHref(html)).not.toBe(configured);
  });

  it("keeps a plain valid invite on its own destination", async () => {
    const configured = "https://discord.gg/Ab12";
    const res = await app.request("/join", {}, { ...env, DISCORD_INVITE_URL: configured });
    expect(res.status).toBe(200);
    expect(joinInviteHref(await res.text())).toBe(configured);
  });

  it("wraps the data-source invite in inviteDestination", () => {
    expect(joinRoutePage).toContain('from "../invite"');
    expect(joinRoutePage).toContain("inviteDestination(c.env.DISCORD_INVITE_URL)");
  });

  it("preserves the widget-snapshot invite chain in the Hono screen", () => {
    expect(joinScreen).toContain("widgetSnapshot.inviteUrl ?? inviteUrl");
  });
});

describe("Kit /join degrades a bad invite to the hardcoded fallback", () => {
  it("wraps the load invite in inviteDestination", () => {
    expect(joinLoad).toContain("inviteDestination(env.DISCORD_INVITE_URL)");
  });

  it("imports the shared invite rule instead of inlining one", () => {
    expect(joinLoad).toMatch(/from\s+"[^"]*src\/invite"/);
  });

  it("preserves the widget-snapshot invite chain in the Kit page", () => {
    expect(joinPage).toContain("widgetSnapshot.inviteUrl ?? inviteUrl");
  });

  it("maps empty and hostile values to the fallback through the shared rule", () => {
    for (const configured of ["", "javascript:alert(1)", "https://evil.test/Ab12"]) {
      expect(inviteDestination(configured)).toBe(FALLBACK_INVITE);
    }
    expect(inviteDestination(FALLBACK_INVITE)).toBe(FALLBACK_INVITE);
  });
});

describe("join result copy lives in one source both renderers read", () => {
  it("exports JOIN_INTRO from the plain-TS home-copy module", () => {
    expect(homeCopy).toContain("export const JOIN_INTRO");
    expect(homeCopy).toContain(JOIN_INTRO_SENTENCE);
  });

  it("no longer defines the intro sentence inside the Hono join screen", () => {
    expect(joinScreen).not.toContain("export const JOIN_INTRO =");
  });

  it("reads the Hono join intro from the shared module", () => {
    expect(joinScreen).toContain('from "../home-copy"');
    expect(joinScreen).toContain("JOIN_INTRO");
  });

  it("flows the shared result copy through the Kit join load", () => {
    expect(joinLoad).toMatch(/HOME_JOIN_RESULT_COPY|JOIN_INTRO|homeCopy|joinCopy/);
  });

  it("renders the Kit join banner from HOME_JOIN_RESULT_COPY", () => {
    expect(joinPage).toContain("HOME_JOIN_RESULT_COPY");
  });

  it("renders the Kit join intro from JOIN_INTRO", () => {
    expect(joinPage).toContain("JOIN_INTRO");
  });

  it("duplicates no result sentence into the Kit join page", () => {
    for (const sentence of Object.values(HOME_JOIN_RESULT_COPY)) {
      expect(joinPage, `hardcoded: ${sentence}`).not.toContain(sentence);
    }
  });

  it("duplicates no intro sentence into the Kit join page", () => {
    expect(joinPage).not.toContain(JOIN_INTRO_SENTENCE);
  });
});

describe("Hono join copy renders the shared bytes", () => {
  it("renders the pinned intro sentence verbatim", async () => {
    const res = await app.request("/join", {}, env);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(JOIN_INTRO_SENTENCE);
  });

  it.each([
    ["added", HOME_JOIN_RESULT_COPY.added],
    ["already_member", HOME_JOIN_RESULT_COPY.alreadyInServer],
  ] as const)("renders the shared %s banner bytes", async (result, sentence) => {
    const cookie = await signedFlashCookie(result);
    const res = await app.request("/join", { headers: { cookie } }, env);
    expect(res.status).toBe(200);
    const html = unescapeHtml(await res.text());
    expect(html).toContain('data-testid="join-result"');
    expect(html).toContain(sentence);
    if (result === "already_member") {
      expect(html).toContain(HOME_JOIN_RESULT_COPY.reinvite);
      expect(html).toContain('data-testid="reinvite-link"');
    }
  });
});

describe("no .tsx import enters the Kit graph", () => {
  it("imports no .tsx module and no Hono screen from web/src", () => {
    const sources = kitSources();
    expect(sources.length).toBeGreaterThan(0);
    const hits = sources
      .filter(
        ({ source }) => /\.tsx["']/.test(source) || /from\s+["'][^"']*\/screens\//.test(source),
      )
      .map(({ path }) => path);
    expect(hits).toEqual([]);
  });

  it("keeps the shared copy module free of the JSX runtime", () => {
    expect(homeCopy).not.toContain("hono/jsx");
    expect(homeCopy).not.toMatch(/from\s+["'][^"']*\.tsx["']/);
    for (const line of homeCopy.split("\n")) {
      if (/^\s*import\s/.test(line)) expect(line).toMatch(/^\s*import\s+type\s/);
    }
  });
});
