import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { build } from "esbuild";
import { parseFragment } from "parse5";
import { expect, it } from "vitest";
import { attr, elements, textOf } from "./helpers/kit-edit-controls";

const root = fileURLToPath(new URL("../", import.meta.url));
const webRequire = createRequire(new URL("../web/package.json", import.meta.url));
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
    const card = (scenario: string) => elements(parseFragment(b[scenario]!));
    const links = (nodes: ReturnType<typeof card>) =>
      nodes.filter((el) => el.tagName === "a").map((el) => attr(el, "href"));
    const testIds = (nodes: ReturnType<typeof card>) => nodes.map((el) => attr(el, "data-testid"));
    const markTexts = (nodes: ReturnType<typeof card>) =>
      nodes.filter((el) => el.tagName === "mark").map(textOf);
    const description = (nodes: ReturnType<typeof card>) =>
      nodes.find((el) => attr(el, "class")?.split(/\s+/).includes("schedule-text"));

    const visitor = card("visitor");
    const cancelled = card("cancelled");
    const discord = card("discord");
    expect(links(visitor)).toContain("/join/discord?next=%2Fevents%3Fpage%3D2");
    expect(links(visitor)).toContain("/e/a");
    expect(visitor.map(textOf)).toContain("Spots open");
    expect(testIds(card("member"))).not.toContain("signin");
    expect(testIds(card("past"))).not.toContain("signin");
    expect(testIds(cancelled)).not.toContain("signin");
    expect(testIds(cancelled)).toContain("event-cancelled");
    expect(links(cancelled)).not.toContain("/e/a");
    expect(links(discord)).toContain("https://discord.test/invite");
    expect(links(discord)).not.toContain("/e/a");
    const pastDiscord = card("pastDiscord");
    expect(testIds(pastDiscord)).toContain("event-card");
    expect(testIds(pastDiscord)).not.toContain("event-discord-rsvp");
    expect(links(pastDiscord)).not.toContain("https://discord.test/invite");

    const marks = card("marks");
    const title = marks.find((el) => el.tagName === "h3");
    expect(title && textOf(title)).toBe("<b>Tom & &copy; x");
    expect(markTexts(elements(title!))).toEqual(["Tom & &copy; "]);
    expect(marks.some((el) => el.tagName === "b")).toBe(false);

    expect(description(card("emptyDescription"))).toBeUndefined();
    const limit = card("limitDescription");
    expect(limit.some((el) => el.tagName === "details")).toBe(false);
    expect(textOf(description(limit)!)).toBe("😀".repeat(240));
    const details = description(card("longDescription"));
    expect(details?.tagName).toBe("details");
    const summary = elements(details!).find((el) => el.tagName === "summary");
    expect(textOf(summary!)).toContain(`${"😀".repeat(240)}…`);
    expect(textOf(elements(details!).find((el) => el.tagName === "p")!)).toBe("😀".repeat(241));
    const passage = card("passage");
    expect(markTexts(passage)).toEqual(["matched & &copy; text"]);
    expect(passage.filter((el) => el.tagName === "p").map(textOf)).toContain("😀".repeat(241));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}, 120000);
