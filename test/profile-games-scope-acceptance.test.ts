// Independent Games/Discord boundary contract (GS-01..GS-05).
// Run: npx vitest run test/profile-games-scope-acceptance.test.ts
// Requires root + web locked dev dependencies; no DB or external service.
// Builder consumes these author-owned files unchanged; do not merge RED alone.
// Breaks caught: unassociated/owner-hidden guidance, a scripted or unsafe role
// link, one forgotten renderer, or two equally incomplete FAQ presentations.
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import type { Env } from "../src/env";
import app from "./app";
import {
  compileGamesScopeKit,
  gamesDescriptionIds,
  gamesScopeLinkName,
  gamesScopeMeanings,
  gamesScopeOrigin,
  renderGamesScopeHono,
  scopeNode,
  scopeTag,
  scopeText,
  type GamesScopeRenderer,
} from "./helpers/profile-games-scope";

let kit: Awaited<ReturnType<typeof compileGamesScopeKit>>;
let faq: Record<"Hono" | "Kit" | "Markdown", string>;
beforeAll(async () => {
  kit = await compileGamesScopeKit();
  const env = { APP_URL: gamesScopeOrigin } as Env;
  const html = await app.request("/faq", {}, env);
  const md = await app.request("/faq.md", {}, env);
  expect(html.status, "fixture GET /faq").toBe(200);
  expect(md.status, "fixture GET /faq.md").toBe(200);
  faq = { Hono: await html.text(), Kit: kit.faq(), Markdown: await md.text() };
});

for (const renderer of ["Hono", "Kit"] as const) {
  const render: GamesScopeRenderer = (props) =>
    renderer === "Hono" ? renderGamesScopeHono(props) : kit.profile(props);
  describe(`${renderer} website interests versus Discord roles`, () => {
    for (const [state, props] of [
      ["initial editor", {}],
      [
        "422 Games validation",
        {
          errors: { games: "Add no more than 20 games." },
          values: {
            bio: "Draft",
            games_text: "Go\nChess",
            timezone: "UTC",
            leaderboard_opt_out: false,
          },
        },
      ],
      ["refused save", { errors: { fields: "Your profile could not be saved. Try again." } }],
    ] as const) {
      it(`GS-01 ${state}: persistent boundary is associated with Games`, () => {
        const html = render(props);
        const ids = gamesDescriptionIds(html);
        expect(ids).toEqual(
          expect.arrayContaining(["profile-games-text-hint", "profile-games-text-count"]),
        );
        const description = scopeText(ids.map((id) => scopeNode(html, id)).join(" "));
        for (const meaning of gamesScopeMeanings)
          expect(description, `${state}: ${meaning}`).toMatch(meaning);
        for (const id of ids) {
          expect(scopeTag(html, id), `${id} resolves`).not.toBe("");
          expect(scopeTag(html, id), `${id} is not hidden`).not.toMatch(
            /\bhidden(?:\s|=|>)|aria-hidden="true"/,
          );
        }
        const allIds = [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
        expect(new Set(allIds).size, "no duplicate IDs").toBe(allIds.length);
        if (props.errors && "games" in props.errors) {
          expect(ids).toContain("profile-games-text-error");
          expect(scopeTag(html, "profile-games-text")).toContain('aria-invalid="true"');
        }
      });
    }

    it("GS-02 offers a descriptive native /discord link inside the owner editor", () => {
      const html = render();
      const form =
        html.match(/<form\b[^>]*data-testid="profile-form"[^>]*>([\s\S]*?)<\/form>/)?.[1] ?? "";
      expect(form, "real owner form").not.toBe("");
      const links = [...form.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)].filter(
        (m) => scopeText(m[2]!) === gamesScopeLinkName,
      );
      expect(links, "one purpose-named native link, not the global Discord nav").toHaveLength(1);
      const attrs = links[0]![1]!;
      expect(attrs).toMatch(/\bhref="\/discord"/);
      expect(attrs).not.toMatch(/\bonclick=|\bdownload(?:\s|=)|href="(?:javascript:|https?:)/i);
      expect(attrs).not.toMatch(/\brole="button"|aria-hidden="true"|tabindex="-1"/);
      // Same-window navigation retains the existing dirty departure warning.
      expect(attrs).not.toMatch(/target="(?!_self")/);
    });

    it("GS-03 CONTROL non-owner profile has neither editor nor role-edit CTA", () => {
      const html = render({ isOwner: false });
      expect(html).not.toContain('data-island="member-profile"');
      expect(html).not.toContain(gamesScopeLinkName);
      expect(scopeTag(html, "profile-games-text")).toBe("");
      expect(html).toContain("Chess");
    });

    it("GS-04 CONTROL preserves composition, error associations, raw draft and timezone help", () => {
      const html = render({
        errors: {
          games: "Add no more than 20 games.",
          bio: "Keep your bio to 1000 characters or fewer.",
        },
        values: {
          bio: "🎮".repeat(1001),
          games_text: "Go\nGo\n\nChess",
          timezone: "UTC",
          leaderboard_opt_out: false,
        },
      });
      expect(scopeText(scopeNode(html, "profile-bio-count"))).toBe(
        "1001 of 1000 characters (1 over the limit)",
      );
      expect(scopeText(scopeNode(html, "profile-games-text-count"))).toBe(
        "2 of 20 games, 12 of 1700 characters",
      );
      expect(scopeText(scopeNode(html, "profile-games-text-hint"))).toContain("Up to 20 games");
      expect(scopeText(scopeNode(html, "profile-games-text-hint"))).toContain(
        "80 characters per game, 1700 characters total",
      );
      expect(gamesDescriptionIds(html)).toContain("profile-games-text-error");
      expect(scopeTag(html, "profile-timezone")).toContain(
        'aria-describedby="profile-timezone-help"',
      );
      expect(scopeText(scopeNode(html, "profile-timezone-help"))).not.toBe("");
      expect(scopeNode(html, "profile-games-text")).toContain("Go\nGo\n\nChess");
      expect(scopeTag(html, "profile-games-text")).not.toMatch(/maxlength/i);
      expect(scopeTag(html, "profile-bio")).not.toMatch(/maxlength/i);
    });
  });
}

function faqGroup(renderer: keyof typeof faq, section: "picker" | "profile") {
  if (renderer === "Markdown") {
    const heading = section === "picker" ? "Game picker" : "Your site profile";
    return (
      faq.Markdown.split(`## ${heading}`)[1]
        ?.split("\n## ")[0]
        ?.replace(/^###? /gm, "")
        .replace(/[*_`]/g, "")
        .replace(/\s+/g, " ")
        .trim() ?? ""
    );
  }
  const id = section === "picker" ? "faq-onboarding" : "faq-profile";
  const group =
    faq[renderer].match(
      new RegExp(`<section\\b[^>]*aria-labelledby="${id}"[^>]*>([\\s\\S]*?)</section>`),
    )?.[1] ?? "";
  return scopeText(group.replace(/<h2\b[^>]*>[\s\S]*?<\/h2>/, ""));
}

for (const renderer of ["Hono", "Kit", "Markdown"] as const) {
  describe(`${renderer} shared FAQ games boundary`, () => {
    for (const section of ["picker", "profile"] as const) {
      it(`GS-05 ${section} answer independently explains the two settings`, () => {
        const text = faqGroup(renderer, section);
        expect(text, "section exists").not.toBe("");
        for (const meaning of gamesScopeMeanings) expect(text, meaning.source).toMatch(meaning);
        expect(text).toMatch(/Discord/i);
        expect(text).toMatch(/picker|pick (?:your |the )?games|select[^.]{0,70}roles/i);
        expect(text).not.toMatch(/discord(?:app)?\.com\/channels\/\d|<#\d+>|<@&\d+>/i);
      });
    }
    it("GS-05 CONTROL preserves the existing picker process without inventing DMs or channel IDs", () => {
      const text = faqGroup(renderer, "picker");
      expect(text).toMatch(/accept[^.]{0,60}rules/i);
      expect(text).toMatch(/welcome[^.]{0,60}landing channel/i);
      expect(text).toMatch(/picker|pick your games/i);
      expect(text).toMatch(/bot[^.]{0,80}(?:grants?|assigns?)[^.]{0,40}roles/i);
      expect(text).toMatch(/never DMs|(?:does not|doesn't|won't) (?:send|DM)|not[^.]{0,30}DM/i);
      expect(text).toMatch(/pick again|pick[^.]{0,50}(?:later|again)|chang[^.]{0,80}picker/i);
    });
  });
}

it("GS-11 CI runs the browser contract opted in and rejects missing or skipped cases", () => {
  const workflow = parse(readFileSync(".github/workflows/ci.yml", "utf8"));
  const job = workflow.jobs.a11y;
  const step = job.steps.find((item: { run?: string }) =>
    item.run?.includes("vitest run test/profile-games-scope-browser.test.ts"),
  );
  expect(step, "wire this new suite beside the existing profile browser suites").toBeDefined();
  expect(step?.env?.A11Y_BROWSER_TESTS ?? job.env?.A11Y_BROWSER_TESTS).toBe("true");
  expect(step?.run).toMatch(/--reporter=json/);
  expect(step?.run).toMatch(
    /a11y-require-executed\.mjs[^\n]+["']Games scope in real Chromium["']\s+10\b/,
  );
});

it("GS-05 CONTROL shared FAQ HTML and Markdown express the same two answers", () => {
  for (const section of ["picker", "profile"] as const) {
    expect(faqGroup("Kit", section)).toBe(faqGroup("Hono", section));
    expect(faqGroup("Markdown", section)).toBe(faqGroup("Hono", section));
  }
});
