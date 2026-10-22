// Independent content contract: identically incomplete renderers must not pass
// parity. Exercise real HTML/Markdown output, with no DB, sessions or network.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { URL, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { faqPageData } from "../src/faq-content";
import type { Env } from "../src/env";
import app from "./app";
import {
  guidanceFor,
  htmlLinks,
  htmlText,
  markdownLinks,
  publicGuidePath,
  readRepo,
  recoveryGuide,
  repoRoot,
} from "./helpers/rsvp-recovery-guide";

const origin = "https://example.test";
const env = { APP_URL: origin } as Env;
const scratch = mkdtempSync(
  join(
    process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.PAPERCLIP_SCRATCH_DIR ?? tmpdir(),
    "faq-recovery-",
  ),
);
const webRequire = createRequire(new URL("../web/package.json", import.meta.url));
const { compile } = webRequire("svelte/compiler") as {
  compile(
    source: string,
    options: { generate: string; dev: boolean; filename: string },
  ): { js: { code: string } };
};
let outputs: Record<"Hono" | "Kit" | "Markdown", string>;

beforeAll(async () => {
  // Adapted from kit-faq-parity.test.ts: compile the actual page and its actual
  // children, not a stand-in that merely repeats faqPageData.
  const entry = join(scratch, "entry.mjs");
  const outfile = join(scratch, "faq.mjs");
  writeFileSync(
    entry,
    `
import { render } from "svelte/server";
import Page from ${JSON.stringify(join(repoRoot, "web/src/routes/faq/+page.svelte"))};
import { LEAF_CRITICAL_CSS } from ${JSON.stringify(join(repoRoot, "src/leaf-critical-css.ts"))};
export const renderPage = data => { const r = render(Page, { props: { data: { ...data, leafCss: LEAF_CRITICAL_CSS } } }); return r.head + r.body; };
`,
  );
  await build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile,
    absWorkingDir: repoRoot,
    nodePaths: [join(repoRoot, "web/node_modules"), join(repoRoot, "node_modules")],
    alias: { "#lib": join(repoRoot, "web/src/lib") },
    plugins: [
      {
        name: "real-faq-ssr",
        setup(plugin) {
          plugin.onLoad({ filter: /\.svelte$/ }, ({ path }) => ({
            contents: compile(readFileSync(path, "utf8"), {
              generate: "server",
              dev: false,
              filename: path,
            }).js.code,
            loader: "js",
            resolveDir: dirname(path),
          }));
        },
      },
    ],
  });
  const { renderPage } = (await import(pathToFileURL(outfile).href)) as {
    renderPage(data: ReturnType<typeof faqPageData>): string;
  };
  const hono = await app.request("/faq", {}, env);
  const markdown = await app.request("/faq.md", {}, env);
  expect(hono.status).toBe(200);
  expect(markdown.status).toBe(200);
  expect(hono.headers.getSetCookie()).toEqual([]);
  expect(markdown.headers.getSetCookie()).toEqual([]);
  outputs = {
    Hono: await hono.text(),
    Kit: renderPage(faqPageData(origin)),
    Markdown: await markdown.text(),
  };
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function eventsText(renderer: keyof typeof outputs) {
  if (renderer === "Markdown") {
    const match = /## Events\s+([\s\S]*?)(?=\n## |$)/.exec(outputs.Markdown);
    expect(match, "Markdown retains the existing Events group").not.toBeNull();
    return match![1]!.replace(/\s+/g, " ");
  }
  const match = /<section\b[^>]*aria-labelledby="faq-events"[^>]*>([\s\S]*?)<\/section>/.exec(
    outputs[renderer],
  );
  expect(match, `${renderer} retains the existing Events group`).not.toBeNull();
  return htmlText(match![1]!);
}

const meanings = [
  [
    "Going is a seat, not measured attendance",
    /going/i,
    /seat|reserv/i,
    /(?:not|isn't|does not|doesn't)[^.]{0,100}attend/i,
  ],
  [
    "Waitlisted is a place in line, not a held seat",
    /waitlist/i,
    /position|place|line|queue/i,
    /(?:not|isn't|does not|doesn't)[^.]{0,90}(?:held|hold|seat|reserv)/i,
  ],
  [
    "released seats promote in FIFO order",
    /releas|withdraw|opens? up|freed/i,
    /promot/i,
    /FIFO|first.in.first.out|order[^.]{0,50}(?:join|line)|(?:first|earliest|oldest)[^.]{0,50}(?:wait|line)/i,
  ],
  [
    "members check the event instead of relying on delivery",
    /reload|refresh/i,
    /(?:no|not|cannot|can't|does not|doesn't|don't|never)[^.]{0,100}(?:notif|alert)/i,
    /(?:not|cannot|can't|does not|doesn't|don't|never)[^.]{0,100}(?:guarantee|deliver)|no[^.]{0,50}(?:delivery|guarantee)/i,
    /Discord/i,
  ],
  [
    "changing and withdrawing an answer remain available",
    /chang|updat/i,
    /withdraw|can't make it|leave the waitlist/i,
  ],
  [
    "saved and pending mirror are not a failed reservation",
    /Saved|saved/i,
    /sync|mirror/i,
    /(?:not|isn't|does not|doesn't)[^.]{0,100}fail/i,
  ],
  [
    "unknown results require checking before another write",
    /couldn't confirm|unknown|uncertain/i,
    /refresh|reload/i,
    /before[^.]{0,100}(?:again|another|writ|resubmi)/i,
  ],
] as const;

for (const renderer of ["Hono", "Kit", "Markdown"] as const) {
  describe(`${renderer} public Events FAQ recovery acceptance`, () => {
    it("positive control: retains public event discovery and sign-in advice", () => {
      const text = eventsText(renderer);
      expect(text).toMatch(/Events page/i);
      expect(text).toMatch(/Discord/i);
      expect(text).toMatch(/log.?in|sign.?in/i);
    });
    for (const [name, ...requirements] of meanings) {
      it(name, () => {
        const text = eventsText(renderer);
        for (const pattern of requirements) expect(text, name).toMatch(pattern);
      });
    }
    it("links to the same focused guide indexed by README", () => {
      const { path } = recoveryGuide();
      const links =
        renderer === "Markdown" ? markdownLinks(outputs[renderer]) : htmlLinks(outputs[renderer]);
      expect(
        links.map(publicGuidePath),
        "real public repository link, not a dead app /docs route",
      ).toContain(path);
    });
  });
}

describe("recovery contract positive and negative controls", () => {
  it("matches a heading decision without borrowing another branch's advice", () => {
    const sample =
      "## Saved\nSaved. Syncing to Discord. Your answer is saved.\n## Unknown\nWe couldn't confirm your RSVP. Refresh before another write.";
    const saved = guidanceFor(sample, /Saved\. Syncing to Discord\./);
    expect(saved).toContain("Your answer is saved");
    expect(saved).not.toContain("Refresh");
    expect(guidanceFor(sample, /couldn't confirm/)).toContain("Refresh before another write");
    expect(() => guidanceFor(sample, /Your session expired/)).toThrow(/recovery branch/);
  });

  it("matches a table decision without mixing outcomes", () => {
    const sample =
      "## Decisions\n| Notice | Next step |\n| Saved. Syncing to Discord. | Do not save again. |\n| Your session expired. | Sign in, then check the event. |";
    const saved = guidanceFor(sample, /Saved\. Syncing to Discord\./);
    expect(saved).toContain("Do not save again");
    expect(saved).not.toContain("Sign in");
  });

  it("recognizes an inspectable public guide link and rejects dead or foreign targets", () => {
    const href = "https://github.com/TogetherWeOwn/two-web-next/blob/main/docs/example-rsvp.md";
    expect(publicGuidePath(htmlLinks(`<a href="${href}">RSVP recovery</a>`)[0]!)).toBe(
      "docs/example-rsvp.md",
    );
    expect(publicGuidePath(markdownLinks(`[RSVP recovery](${href})`)[0]!)).toBe(
      "docs/example-rsvp.md",
    );
    expect(publicGuidePath("/docs/example-rsvp.md")).toBeNull();
    expect(publicGuidePath("https://example.test/docs/example-rsvp.md")).toBeNull();
  });
});

describe("focused RSVP recovery guide and support boundaries", () => {
  it("connects the existing moderator incident section to the indexed guide", () => {
    const { path } = recoveryGuide();
    const incidents =
      readRepo("docs/moderator-admin-guide.md")
        .split("## Moderator boundaries and incidents")[1]
        ?.split("\n## ")[0] ?? "";
    expect(markdownLinks(incidents).map((link) => `docs/${link.split("#")[0]}`)).toContain(path);
  });

  it("reuses join/sign-in recovery and cites the actual RSVP sources", () => {
    const { body } = recoveryGuide();
    const links = markdownLinks(body);
    expect(links.some((link) => /(?:^|\/)troubleshooting-join\.md(?:#|$)/.test(link))).toBe(true);
    for (const source of [
      "contracts-rsvp-button.ts",
      "routes-rsvp.tsx",
      "rsvp.ts",
      "waitlist.ts",
    ]) {
      expect(
        links.some((link) => link.split("#")[0]!.endsWith(`/${source}`)),
        `source reference: ${source}`,
      ).toBe(true);
    }
  });

  for (const [name, outcome, next, stop] of [
    [
      "expired session",
      /Your session expired|session expiry/i,
      /sign.?in|log.?in|troubleshooting-join/,
      /check[^.]{0,80}(?:event|answer)|do not[^.]{0,80}replay/i,
    ],
    [
      "throttled write",
      /Slow down|Retry-After|throttl/i,
      /wait/i,
      /(?:do not|don't|never)[^.]{0,100}(?:repeat|bypass|click|retry)|stop|escalat/i,
    ],
    [
      "paused event",
      /paused/i,
      /check back|reload|refresh/i,
      /stop|moderator|support|do not|don't/i,
    ],
    [
      "ended event",
      /\bended\b|been and gone|past event/i,
      /events|replacement|another event/i,
      /stop|do not|don't|cannot|can't/i,
    ],
    [
      "cancelled event",
      /cancelled/i,
      /events|replacement|another event/i,
      /stop|do not|don't|cannot|can't/i,
    ],
    [
      "network uncertainty",
      /couldn't confirm|unknown|uncertain/i,
      /refresh|reload/i,
      /before[^.]{0,100}(?:again|another|writ|resubmi)|stop/i,
    ],
    [
      // Persistent delay is a sub-branch inside Saved: pin the Saved heading,
      // then assert its persistent-specific escalation and do-not-resubmit stop.
      "persistent mirror delay",
      /Saved\. Syncing to Discord\./,
      /moderator|support|escalat/i,
      /(?:do not|don't|never)[^.]{0,100}(?:sav|resubmi|repeat|mirror|retry)/i,
    ],
  ] as const) {
    it(`gives ${name} a bounded next step and stop condition`, () => {
      const branch = guidanceFor(recoveryGuide().body, outcome);
      expect(branch).toMatch(next);
      expect(branch).toMatch(stop);
    });
  }

  it("limits escalation to sanitized path, visible sentence and approximate time/timezone", () => {
    const body = recoveryGuide().body.replace(/[*_`]/g, "").replace(/\s+/g, " ");
    expect(body).toMatch(/saniti[sz]|strip|remove/i);
    expect(body).toMatch(/(?:page )?path/i);
    expect(body).toMatch(/exact visible (?:sentence|wording|message)/i);
    expect(body).toMatch(/approximate time/i);
    expect(body).toMatch(/time\s?zone/i);
    expect(body).toMatch(/private support|support (?:button|ticket|process)|DM a moderator/i);
    for (const forbidden of [
      /roster|member[^.]{0,30}export/i,
      /callback[^.]{0,30}quer/i,
      /cookie/i,
      /header/i,
      /credential/i,
      /SQL/i,
      /queue[^.]{0,20}replay/i,
    ]) {
      expect(body, `explicit support boundary ${forbidden}`).toMatch(forbidden);
    }
    expect(body).not.toMatch(
      /```(?:sql|sh|bash)[\s\S]*?(?:UPDATE |DELETE |INSERT |curl |redispatch)/i,
    );
  });

  it("never presents dormant syncFailed copy as a current server outcome", () => {
    const body = recoveryGuide().body;
    // Omission is valid: this is a member guide, not a client internals guide.
    if (/syncFailed|sync_failed|Saved\. Discord sync didn't go through/i.test(body)) {
      const branch = guidanceFor(
        body,
        /syncFailed|sync_failed|Saved\. Discord sync didn't go through/i,
      );
      expect(branch).toMatch(
        /dormant|not (?:currently )?(?:emitted|returned|sent)|does not (?:currently )?(?:emit|return|send)/i,
      );
    }
  });
});
