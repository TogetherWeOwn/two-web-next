import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { build } from "esbuild";
import { type DefaultTreeAdapterTypes as Dom, parseFragment } from "parse5";
import { expect, it } from "vitest";
import { attr, elements } from "./helpers/kit-edit-controls";

const root = fileURLToPath(new URL("../", import.meta.url));
const webRequire = createRequire(new URL("../web/package.json", import.meta.url));
const { renderedElements, renderedText } = webRequire("../ci/rendered-page.mjs") as {
  renderedElements(node: Dom.Node, selector: { tag: string }): Iterable<Dom.Element>;
  renderedText(node: Dom.Node): string;
};
const { compile } = webRequire("svelte/compiler") as {
  compile: (
    s: string,
    o: { generate: string; dev: boolean; filename: string },
  ) => {
    js: { code: string };
  };
};

const ENTRY = `import { render } from "svelte/server";
import CalendarCard from ${JSON.stringify(join(root, "web/src/lib/CalendarCard.svelte"))};
const event = { kind: "event", key: "a", eventKey: "a", title: "Night", titleSegments: null,
  zone: "UTC", startsAt: new Date("2030-06-01T18:00:00Z"), endsAt: null, location: null,
  description: null, passage: null, availability: { state: "open", text: "Spots open", ongoing: false },
  status: "published", game: null, host: "", goingCount: 1, goingOccupancy: 1, capacity: null };
const renderCard = (e, o = {}) => render(CalendarCard, { props: { e, isPast: false, member: false,
  inviteUrl: "https://discord.test/invite", loginReturnTo: "/events?page=2", ...o } }).body;
const discord = { ...event, kind: "discord", key: "discord-9" };
export const bodies = {
  visitor: renderCard(event),
  member: renderCard(event, { member: true }),
  past: renderCard(event, { isPast: true }),
  cancelled: renderCard({ ...event, status: "cancelled", availability: null }),
  discord: renderCard(discord),
  pastDiscord: renderCard(discord, { isPast: true }),
  marks: renderCard({ ...event, titleSegments: [{ text: "<b>", match: false },
    { text: "Tom & &copy; ", match: true }, { text: "x", match: false }] }),
  emptyDescription: renderCard({ ...event, description: "" }),
  limitDescription: renderCard({ ...event, description: "😀".repeat(240) }),
  longDescription: renderCard({ ...event, description: "😀".repeat(241) }),
  passage: renderCard({ ...event, description: "😀".repeat(241),
    passage: [{ text: "matched & &copy; text", match: true }] }),
};`;

it("renders calendar card actions and escapes search spans", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "kit-calendar-card-"));
  try {
    const entry = join(scratch, "entry.mjs");
    const outfile = join(scratch, "bundle.mjs");
    writeFileSync(entry, ENTRY);
    await build({
      entryPoints: [entry],
      outfile,
      bundle: true,
      platform: "node",
      format: "esm",
      absWorkingDir: root,
      nodePaths: [join(root, "web/node_modules"), join(root, "node_modules")],
      plugins: [
        {
          name: "calendar-card-ssr",
          setup(plugin) {
            plugin.onLoad({ filter: /\.svelte$/ }, (args) => ({
              contents: compile(readFileSync(args.path, "utf8"), {
                generate: "server",
                dev: false,
                filename: args.path,
              }).js.code,
              loader: "js",
              resolveDir: dirname(args.path),
            }));
          },
        },
      ],
    });
    const { bodies: b } = (await import(pathToFileURL(outfile).href)) as {
      bodies: Record<string, string>;
    };
    const card = (scenario: string, scriptingEnabled = true) =>
      elements(parseFragment(b[scenario]!, { scriptingEnabled }));
    const links = (nodes: ReturnType<typeof card>) =>
      nodes.filter((el) => el.tagName === "a").map((el) => attr(el, "href"));
    const testIds = (nodes: ReturnType<typeof card>) => nodes.map((el) => attr(el, "data-testid"));
    const markTexts = (node: Dom.Node) =>
      [...renderedElements(node, { tag: "mark" })].map(renderedText);
    const description = (nodes: ReturnType<typeof card>) =>
      nodes.find((el) => attr(el, "class")?.split(/\s+/).includes("schedule-text"));

    const visitor = card("visitor");
    const cancelled = card("cancelled", false);
    expect(links(visitor)).toContain("/join/discord?next=%2Fevents%3Fpage%3D2");
    expect(links(visitor)).toContain("/e/a");
    expect(renderedText(parseFragment(b.visitor!))).toContain("Spots open");
    expect(testIds(card("member", false))).not.toContain("signin");
    expect(testIds(card("past", false))).not.toContain("signin");
    expect(testIds(cancelled)).not.toContain("signin");
    expect(testIds(card("cancelled"))).toContain("event-cancelled");
    expect(links(cancelled)).not.toContain("/e/a");
    expect(links(card("discord"))).toContain("https://discord.test/invite");
    expect(links(card("discord", false))).not.toContain("/e/a");
    const pastDiscord = card("pastDiscord", false);
    expect(testIds(card("pastDiscord"))).toContain("event-card");
    expect(testIds(pastDiscord)).not.toContain("event-discord-rsvp");
    expect(links(pastDiscord)).not.toContain("https://discord.test/invite");

    const marks = parseFragment(b.marks!);
    const [title] = renderedElements(marks, { tag: "h3" });
    expect(title && renderedText(title)).toBe("<b>Tom & &copy; x");
    expect(markTexts(title!)).toEqual(["Tom & &copy; "]);
    expect(elements(marks).some((el) => el.tagName === "b")).toBe(false);

    expect(description(card("emptyDescription"))).toBeUndefined();
    const limit = card("limitDescription");
    expect(limit.some((el) => el.tagName === "details")).toBe(false);
    expect(renderedText(description(limit)!)).toBe("😀".repeat(240));
    const details = description(card("longDescription"));
    expect(details?.tagName).toBe("details");
    const [summary] = renderedElements(details!, { tag: "summary" });
    expect(renderedText(summary!)).toContain(`${"😀".repeat(240)}…`);
    const [fullDescription] = renderedElements(details!, { tag: "p" });
    expect(renderedText(fullDescription!)).toBe("😀".repeat(241));
    const passage = parseFragment(b.passage!);
    expect(markTexts(passage)).toEqual(["matched & &copy; text"]);
    const paragraphs = [...renderedElements(passage, { tag: "p" })];
    expect(paragraphs.map(renderedText)).toContain("😀".repeat(241));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}, 120000);
