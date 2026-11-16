import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { build } from "esbuild";
import { expect, it } from "vitest";

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
export const bodies = {
  visitor: renderCard(event),
  member: renderCard(event, { member: true }),
  past: renderCard(event, { isPast: true }),
  cancelled: renderCard({ ...event, status: "cancelled", availability: null }),
  discord: renderCard({ ...event, kind: "discord", key: "discord-9" }),
  marks: renderCard({ ...event, titleSegments: [{ text: "<b>", match: false },
    { text: "Tom & ", match: true }, { text: "x", match: false }] }),
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
    expect(b.visitor).toContain('href="/join/discord?next=%2Fevents%3Fpage%3D2"');
    expect(b.visitor).toContain('href="/e/a"');
    expect(b.visitor).toContain("Spots open");
    expect(b.member).not.toContain('data-testid="signin"');
    expect(b.past).not.toContain('data-testid="signin"');
    expect(b.cancelled).toContain('data-testid="event-cancelled"');
    expect(b.cancelled).not.toContain('href="/e/a"');
    expect(b.cancelled).not.toContain('data-testid="signin"');
    expect(b.discord).toContain('href="https://discord.test/invite"');
    expect(b.discord).not.toContain('href="/e/a"');
    expect(b.marks).toMatch(
      /&lt;b(?:>|&gt;)(?:<!--[\s\S]*?-->)*<mark>Tom &amp; <\/mark>(?:<!--[\s\S]*?-->)*x/,
    );
    expect(b.marks).not.toContain("<b>");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}, 120000);
