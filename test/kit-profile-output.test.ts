// Authenticated Kit profile output stays inside the Hono member-visible contract.
// SSR-compiles the real Svelte view and compares its visible fields with Hono's
// ProfilePage while checking leaderboard opt-out and viewer data stay private.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { build } from "esbuild";
import { beforeAll, describe, expect, it } from "vitest";
import { resolveKitProfile } from "../src/profiles/kit";
import { ProfilePage } from "../src/profiles/pages";
import { createMemoryProfileStore, type MemberView } from "../src/profiles/store";

const APP_URL = "https://next.example.test";
const PRIVATE_SESSION_MARKER = "viewer-session-secret-must-not-render";

const webRequire = createRequire(new URL("../web/package.json", import.meta.url));
const { compile } = webRequire("svelte/compiler") as {
  compile: (
    source: string,
    options: { generate: string; dev: boolean; filename: string },
  ) => { js: { code: string } };
};

type RenderView = (props: Record<string, unknown>) => { html: string; head: string };

// Read only the rendered head: a body tag or copied helper value cannot
// conceal removal of either independent ProfileView share-image tag.
function expectBrandImage(head: string) {
  const contents = (property: string) =>
    [...head.matchAll(/<meta\s+[^>]*>/g)]
      .map(([tag]) => tag)
      .filter((tag) => tag.includes(`property="${property}"`))
      .map((tag) => tag.match(/content="([^"]*)"/)?.[1]);
  expect(contents("og:image")).toEqual(["https://next.example.test/og-1200x630.png"]);
  expect(contents("og:image:alt")).toEqual(["Together We Own community logo"]);
}

let renderView: RenderView;

const member: MemberView = {
  id: "100000000000000101",
  username: "Public Member",
  avatar: "avataroutputcanary",
  bio: "Member bio",
  games: ["Chess", "Go"],
  timezone: "Europe/London",
  joinedAt: new Date("2024-06-15T00:00:00Z"),
  leaderboardOptOut: true,
};
function visibleContract(html: string): string[] {
  const text = (value: string | undefined) => value?.replace(/\s+/g, " ").trim() ?? "";
  const capture = (pattern: RegExp) => {
    const match = html.match(pattern);
    expect(match, pattern.source).not.toBeNull();
    return text(match?.[1]);
  };
  const games = [...html.matchAll(/<div data-testid="profile-games">([\s\S]*?)<\/div>/g)];
  expect(games).toHaveLength(1);
  const gameNames = [...(games[0]?.[1] ?? "").matchAll(/<li[^>]*>([^<]*)<\/li>/g)].map((match) =>
    text(match[1]),
  );
  expect(gameNames).toHaveLength(member.games.length);
  const avatar = html.match(/<span data-testid="profile-avatar"[^>]*>([\s\S]*?)<\/span>/);
  expect(avatar).not.toBeNull();
  const image = avatar?.[1]?.match(/<img src="([^"]+)"/);
  expect(image).not.toBeNull();
  return [
    text(image?.[1]),
    capture(/data-testid="profile-name"[^>]*>([\s\S]*?)<\/h1>/),
    capture(/data-testid="profile-handle"[^>]*>([\s\S]*?)<\/p>/),
    capture(/data-testid="profile-bio"[^>]*>([\s\S]*?)<\/p>/),
    gameNames.join(" "),
    capture(/data-testid="profile-timezone"[^>]*>([\s\S]*?)<\/p>/),
    capture(/data-testid="profile-joined"[^>]*>([\s\S]*?)<\/p>/),
  ];
}

beforeAll(async () => {
  const worktree = fileURLToPath(new URL("../", import.meta.url));
  const scratch = mkdtempSync(join(tmpdir(), "kit-profile-output-"));
  const entry = join(scratch, "kit-profile-output-entry.mjs");
  writeFileSync(
    entry,
    `
import { render } from "svelte/server";
import View from ${JSON.stringify(join(worktree, "web/src/lib/ProfileView.svelte"))};
export function renderView(props) {
  const { body, head } = render(View, { props });
  return { html: head + body, head };
}
`,
  );
  const outfile = join(scratch, "kit-profile-output.mjs");
  await build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile,
    logLevel: "warning",
    absWorkingDir: worktree,
    nodePaths: [join(worktree, "web/node_modules"), join(worktree, "node_modules")],
    plugins: [
      {
        name: "kit-profile-output-svelte-ssr",
        setup(plugin) {
          plugin.onLoad({ filter: /\.svelte$/ }, (args) => {
            const source = readFileSync(args.path, "utf8");
            const { js } = compile(source, { generate: "server", dev: false, filename: args.path });
            return { contents: js.code, loader: "js", resolveDir: dirname(args.path) };
          });
        },
      },
    ],
  });
  ({ renderView } = (await import(pathToFileURL(outfile).href)) as { renderView: RenderView });
  rmSync(scratch, { recursive: true, force: true });
}, 120000);

function leaksViewerIdentity(html: string): boolean {
  return html.includes(PRIVATE_SESSION_MARKER);
}

describe("Kit authenticated public-member profile output", () => {
  it("matches Hono's visible fields without exposing opt-out or viewer identity", async () => {
    const viewerId = "100000000000000202";
    const session = {
      status: "authenticated" as const,
      session: {
        userId: viewerId,
        username: PRIVATE_SESSION_MARKER,
        avatar: null,
        member: true,
        moderator: true,
        // Extra runtime data must never be projected into a profile response.
        token: "credential-canary",
      },
    };
    const outcome = await resolveKitProfile(
      { session, requestedId: member.id, joinResult: null },
      { store: createMemoryProfileStore([member]) },
    );
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect(outcome).toMatchObject({
      member,
      stats: null,
      isOwner: false,
      isModerator: true,
      joinResult: null,
    });
    expect(outcome).not.toHaveProperty("session");
    expect(JSON.stringify(outcome)).not.toContain(viewerId);
    expect(JSON.stringify(outcome)).not.toContain(PRIVATE_SESSION_MARKER);
    expect(JSON.stringify(outcome)).not.toContain("credential-canary");

    const pageProps = {
      member: outcome.member,
      stats: outcome.stats,
      isOwner: outcome.isOwner,
      isModerator: outcome.isModerator,
      appUrl: APP_URL,
      joinResult: outcome.joinResult,
    };
    const { html: kitHtml, head: kitHead } = renderView(pageProps);
    expectBrandImage(kitHead);
    const honoHtml = ProfilePage(pageProps)!.toString() as string;

    expect(visibleContract(kitHtml)).toEqual(visibleContract(honoHtml));
    for (const html of [kitHtml, honoHtml]) {
      expect(html).toContain("Public Member");
      expect(html).toContain("Member bio");
      expect(html).toContain("Chess");
      expect(html).toContain("Go");
      expect(html).toContain("Europe/London");
      expect(html).toContain("Joined June 2024");
      expect(html).toContain('name="robots" content="noindex, nofollow"');
      expect(html).toContain('action="/logout"');
      expect(html).toContain('data-testid="profile-admin-link"');
      expect(html).not.toContain("Edit your profile");
      expect(html).not.toContain("leaderboard_opt_out");
      expect(html).not.toContain("Hide me from the member leaderboard");
      expect(html).not.toContain(viewerId);
      expect(leaksViewerIdentity(html)).toBe(false);
    }
  });

  it("keeps the authenticated owner's private edit controls aligned with Hono", async () => {
    const session = {
      status: "authenticated" as const,
      session: {
        userId: member.id,
        username: PRIVATE_SESSION_MARKER,
        avatar: null,
        member: true,
        moderator: false,
      },
    };
    const outcome = await resolveKitProfile(
      { session, requestedId: member.id, joinResult: null },
      { store: createMemoryProfileStore([member]) },
    );
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect(outcome.isOwner).toBe(true);
    expect(outcome.isModerator).toBe(false);

    const pageProps = {
      member: outcome.member,
      stats: outcome.stats,
      isOwner: outcome.isOwner,
      isModerator: outcome.isModerator,
      appUrl: APP_URL,
      joinResult: outcome.joinResult,
    };
    const { html: kitHtml, head: kitHead } = renderView(pageProps);
    expectBrandImage(kitHead);
    const honoHtml = ProfilePage(pageProps)!.toString() as string;

    expect(visibleContract(kitHtml)).toEqual(visibleContract(honoHtml));
    for (const html of [kitHtml, honoHtml]) {
      expect(html).toContain('data-testid="profile-form"');
      expect(html).toContain("Edit your profile");
      expect(html).toMatch(/<input[^>]*name="leaderboard_opt_out"[^>]*checked/);
      expect(leaksViewerIdentity(html)).toBe(false);
    }
  });
});
