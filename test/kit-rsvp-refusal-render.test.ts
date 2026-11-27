// Kit RSVP refusal presentation: the real RsvpRefusal.svelte, compiled with
// the web workspace's svelte/compiler and bundled by esbuild (same harness
// shape as test/kit-profile-form.test.ts), rendered with refusal models.
// The Svelte adapter must keep the served refusal contract from
// src/events/rsvp-refusal-hono.tsx: the event back nav, the failure heading,
// the announced message and the return-to-event link — so the no-JS outcome
// reads the same whichever renderer owns the bytes.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { build } from "esbuild";
import { beforeAll, describe, expect, it } from "vitest";
import { RSVP_COPY, throttleWaitCopy } from "../src/islands/contracts-rsvp-button";
import {
  RSVP_REFUSAL_GENERIC_MESSAGE,
  rsvpRefusalModelFor,
  type RsvpRefusalModel,
} from "../src/events/rsvp-refusal";
import {
  childText,
  documentElements,
  element,
  elements,
  parseRenderedPage,
  renderedAttribute,
  text,
} from "./helpers/rendered-dom.mjs";

const webRequire = createRequire(new URL("../web/package.json", import.meta.url));
const { compile } = webRequire("svelte/compiler") as {
  compile: (
    source: string,
    options: { generate: string; dev: boolean; filename: string },
  ) => { js: { code: string } };
};

type RenderRefusal = (props: RsvpRefusalModel) => string;

let renderHtml: RenderRefusal;

function renderRefusal(props: RsvpRefusalModel) {
  return parseRenderedPage(renderHtml(props));
}

beforeAll(async () => {
  const worktree = fileURLToPath(new URL("../", import.meta.url));
  const scratch = mkdtempSync(join(tmpdir(), "kit-rsvp-refusal-"));
  const entry = join(scratch, "kit-rsvp-refusal-entry.mjs");
  writeFileSync(
    entry,
    `
import { render } from "svelte/server";
import Refusal from ${JSON.stringify(join(worktree, "web/src/lib/RsvpRefusal.svelte"))};
export function renderRefusal(props) {
  const { head, body } = render(Refusal, { props });
  return "<head>" + head + "</head><body>" + body + "</body>";
}
`,
  );
  const outfile = join(scratch, "kit-rsvp-refusal.mjs");
  await build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile,
    logLevel: "warning",
    absWorkingDir: worktree,
    nodePaths: [join(worktree, "web/node_modules"), join(worktree, "node_modules")],
    alias: { "#lib": fileURLToPath(new URL("../web/src/lib/", import.meta.url)) },
    plugins: [
      {
        name: "kit-rsvp-refusal-svelte-ssr",
        setup(plugin) {
          plugin.onLoad({ filter: /\.svelte$/ }, (args) => {
            const source = readFileSync(args.path, "utf8");
            const { js } = compile(source, {
              generate: "server",
              dev: false,
              filename: args.path,
            });
            return { contents: js.code, loader: "js", resolveDir: dirname(args.path) };
          });
        },
      },
    ],
  });
  ({ renderRefusal: renderHtml } = (await import(pathToFileURL(outfile).href)) as {
    renderRefusal: RenderRefusal;
  });
  rmSync(scratch, { recursive: true, force: true });
}, 120000);

describe("Kit RSVP refusal presentation", () => {
  it("renders the generic refusal with the back nav, heading, alert and return link", () => {
    const page = renderRefusal(
      rsvpRefusalModelFor({ status: 403, retryAfter: null, eventKey: "EVT" }),
    );
    const main = element(page, "main");
    expect(text(element(main, "h1"))).toBe(RSVP_COPY.failedTitle);
    const alerts = elements(main, "p", { role: "alert" });
    expect(alerts).toHaveLength(1);
    expect(alerts.map(text)).toContain(RSVP_REFUSAL_GENERIC_MESSAGE);
    expect(text(element(main, "a", { href: "/e/EVT" }))).toBe("Return to the event");
    const calendar = element(main, "nav", { "aria-label": "Event calendar" });
    expect(text(element(calendar, "a", { href: "/events" }))).toBe("← All events");
    const head = element(page, "head");
    const titles = head.childNodes
      .filter((node) => "tagName" in node)
      .filter((node) => node.tagName === "title");
    expect(titles.map(childText)).toEqual([`${RSVP_COPY.failedTitle} — Together We Own`]);
  });

  it("renders the throttled refusal with the announced wait", () => {
    const page = renderRefusal(
      rsvpRefusalModelFor({ status: 429, retryAfter: "7", eventKey: "EVT" }),
    );
    expect(text(element(page, "p", { role: "alert" }))).toBe(throttleWaitCopy(7));
    expect(text(page)).not.toContain(RSVP_REFUSAL_GENERIC_MESSAGE);
  });

  it("escapes the message instead of rendering raw HTML", () => {
    const hostile = '</p><script>alert("xss")</script>';
    const page = renderRefusal({
      title: RSVP_COPY.failedTitle,
      message: hostile,
      returnPath: "/e/EVT",
    });
    expect(text(element(element(page, "main"), "p", { role: "alert" }))).toBe(hostile);
    expect(documentElements(page, "script").map(childText)).not.toContainEqual(
      expect.stringContaining('alert("xss")'),
    );
  });

  it("marks Events as the current location, like its Hono oracle", () => {
    const page = renderRefusal(
      rsvpRefusalModelFor({ status: 403, retryAfter: null, eventKey: "EVT" }),
    );
    const nav = element(page, "nav", { "aria-label": "Primary" });
    const events = element(nav, "a", { href: "/events" });
    expect(text(events)).toBe("Events");
    expect(renderedAttribute(events, "aria-current")).toBe("location");
  });

  it("keeps the served shell chrome: event theme, no account area, skip link", () => {
    const page = renderRefusal(
      rsvpRefusalModelFor({ status: 503, retryAfter: null, eventKey: "EVT" }),
    );
    expect(elements(page, "div", { "data-theme": "event" })).toHaveLength(1);
    expect(elements(page, "nav", { "aria-label": "Account" })).toEqual([]);
    expect(text(page)).not.toContain("Welcome, guest");
    expect(elements(page, "a").map((link) => renderedAttribute(link, "href"))).not.toContainEqual(
      expect.stringMatching(/^\/join\/discord/),
    );
    expect(text(element(page, "a", { href: "#main" }))).toBe("Skip to content");
    expect(elements(page, "main", { id: "main" })).toHaveLength(1);
  });
});
