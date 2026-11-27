// Authenticated Kit profile output stays inside the Hono member-visible contract.
// SSR-compiles the real Svelte view and compares its visible fields with Hono's
// ProfilePage while checking leaderboard opt-out and viewer data stay private.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { build } from "esbuild";
import { parse } from "parse5";
import { assert, beforeAll, describe, expect, it } from "vitest";
import { resolveKitProfile } from "../src/profiles/kit";
import { ProfilePage } from "../src/profiles/pages";
import { createMemoryProfileStore, type MemberView } from "../src/profiles/store";
import { attr, elements, textOf } from "./helpers/kit-edit-controls";

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

function parseHead(html: string) {
  const head = elements(parse(html)).find((el) => el.tagName === "head");
  assert(head);
  return head;
}

// Read only the rendered head: a body tag or copied helper value cannot
// conceal removal of either independent ProfileView share-image tag.
function expectBrandImage(head: string) {
  const metas = elements(parseHead(head)).filter((el) => el.tagName === "meta");
  const contents = (property: string) =>
    metas.filter((el) => attr(el, "property") === property).map((el) => attr(el, "content"));
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
function findElement(nodes: ReturnType<typeof elements>, tag: string, name: string, value: string) {
  return nodes.find((el) => el.tagName === tag && attr(el, name) === value);
}

function expectVisibleContract(nodes: ReturnType<typeof elements>) {
  const games = nodes.filter((el) => attr(el, "data-testid") === "profile-games");
  expect(games).toHaveLength(1);
  const [list] = games;
  const avatar = findElement(nodes, "span", "data-testid", "profile-avatar");
  assert(list?.tagName === "div" && avatar);
  const image = elements(avatar).find((el) => el.tagName === "img");
  assert(image);
  expect(attr(image, "src")).toBe(
    `https://cdn.discordapp.com/avatars/${member.id}/${member.avatar}.png?size=128`,
  );
  const items = elements(list).filter((el) => el.tagName === "li");
  expect(items.map((el) => textOf(el).trim())).toEqual(["Chess", "Go"]);
  for (const [tag, id, text] of [
    ["h1", "name", "Public Member"],
    ["p", "handle", "@Public Member"],
    ["p", "bio", "Member bio"],
    ["p", "timezone", "Timezone: Europe/London"],
    ["p", "joined", "Joined June 2024"],
  ] as const) {
    const el = findElement(nodes, tag, "data-testid", `profile-${id}`);
    assert(el, `Expected profile-${id}`);
    expect(textOf(el).replace(/\s+/g, " ").trim()).toBe(text);
  }
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

// These are response-wide privacy canaries, including comments and other non-rendered bytes.
function expectPrivateDataAbsent(html: string, ...markers: string[]) {
  for (const marker of [PRIVATE_SESSION_MARKER, ...markers]) expect(html).not.toContain(marker);
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

    for (const html of [kitHtml, honoHtml]) {
      const page = parse(html);
      const nodes = elements(page);
      expectVisibleContract(nodes);
      const head = nodes.find((el) => el.tagName === "head");
      assert(head);
      const robots = findElement(elements(head), "meta", "name", "robots");
      assert(robots);
      expect(attr(robots, "content")).toBe("noindex, nofollow");
      const signOut = findElement(nodes, "form", "action", "/logout");
      const admin = findElement(nodes, "a", "data-testid", "profile-admin-link");
      assert(signOut);
      assert(admin);
      expect(attr(signOut, "method")).toBe("post");
      expect(attr(admin, "href")).toBe("/admin");
      const text = textOf(page);
      const attributes = nodes.flatMap((el) => el.attrs.map(({ value }) => value));
      for (const copy of ["Edit your profile", "Hide me from the member leaderboard"]) {
        expect(text).not.toContain(copy);
        expect(attributes.some((value) => value.includes(copy))).toBe(false);
      }
      expect(nodes.some((el) => attr(el, "name") === "leaderboard_opt_out")).toBe(false);
      expect(nodes.some((el) => attr(el, "data-saved-leaderboard-opt-out") !== undefined)).toBe(
        false,
      );
      expectPrivateDataAbsent(html, viewerId, "credential-canary", "leaderboard_opt_out");
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

    for (const html of [kitHtml, honoHtml]) {
      const nodes = elements(parse(html));
      expectVisibleContract(nodes);
      const form = findElement(nodes, "form", "data-testid", "profile-form");
      const heading = findElement(nodes, "h2", "id", "edit-heading");
      assert(form && heading);
      expect(textOf(heading).trim()).toBe("Edit your profile");
      const checkbox = findElement(elements(form), "input", "id", "profile-leaderboard-opt-out");
      assert(checkbox);
      expect(attr(checkbox, "name")).toBe("leaderboard_opt_out");
      expect(attr(checkbox, "type")).toBe("checkbox");
      expect(attr(checkbox, "checked")).toBeDefined();
      expectPrivateDataAbsent(html);
    }
  });
});
