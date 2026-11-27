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
import { defaultTreeAdapter, type DefaultTreeAdapterMap, type parse } from "parse5";
import { assert, beforeAll, describe, expect, it } from "vitest";
import { RSVP_COPY, throttleWaitCopy } from "../src/islands/contracts-rsvp-button";
import {
  RSVP_REFUSAL_GENERIC_MESSAGE,
  rsvpRefusalModelFor,
  type RsvpRefusalModel,
} from "../src/events/rsvp-refusal";
import { attr, elements, textOf } from "./helpers/kit-edit-controls";

type Element = DefaultTreeAdapterMap["element"];
type Node = DefaultTreeAdapterMap["node"];

const requireHere = createRequire(import.meta.url);
const { parseRenderedPage, renderedAttribute, renderedElements, renderedText } = requireHere(
  "../ci/rendered-page.mjs",
) as {
  parseRenderedPage: typeof parse;
  renderedAttribute: (element: Element, name: string) => string | undefined;
  renderedElements: (
    root: Node,
    selector: { tag?: string; id?: string; role?: string },
  ) => Iterable<Element>;
  renderedText: (root: Node) => string;
};

const webRequire = createRequire(new URL("../web/package.json", import.meta.url));
const { compile } = webRequire("svelte/compiler") as {
  compile: (
    source: string,
    options: { generate: string; dev: boolean; filename: string },
  ) => { js: { code: string } };
};

type RenderRefusal = (props: RsvpRefusalModel) => string;

let renderRefusal: RenderRefusal;

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
  ({ renderRefusal } = (await import(pathToFileURL(outfile).href)) as {
    renderRefusal: RenderRefusal;
  });
  rmSync(scratch, { recursive: true, force: true });
}, 120000);

function renderPage(status: number, retryAfter: string | null = null) {
  const html = renderRefusal(rsvpRefusalModelFor({ status, retryAfter, eventKey: "EVT" }));
  return parseRenderedPage(html, { scriptingEnabled: false });
}

function* parsedNodes(node: Node): Generator<Node> {
  yield node;
  if ("childNodes" in node) {
    for (const child of node.childNodes) yield* parsedNodes(child);
  }
  if ("content" in node) yield* parsedNodes(node.content);
}

function parsedElements(root: Node) {
  return [...parsedNodes(root)].filter(defaultTreeAdapter.isElementNode);
}

function expectNoParsedCopy(root: Node, copy: string) {
  const nodes = [...parsedNodes(root)];
  const text = nodes.filter(defaultTreeAdapter.isTextNode).map((node) => node.value);
  const comments = nodes.filter(defaultTreeAdapter.isCommentNode).map((node) => node.data);
  const attributes = parsedElements(root).flatMap(({ attrs }) => attrs.map(({ value }) => value));
  expect(text.join("")).not.toContain(copy);
  expect([...comments, ...attributes].filter((value) => value.includes(copy))).toEqual([]);
}

function refusalAlert(document: Node) {
  // Count parsed fallback alerts too. The shared visibility query skips noscript.
  expect(
    parsedElements(document).filter((element) => attr(element, "role") === "alert"),
  ).toHaveLength(1);
  const [alert] = renderedElements(document, { role: "alert" });
  assert(alert);
  return alert;
}

describe("Kit RSVP refusal presentation", () => {
  it("renders the generic refusal with the back nav, heading, alert and return link", () => {
    const document = renderPage(403);
    expect([...renderedElements(document, { tag: "h1" })].map(renderedText)).toEqual([
      RSVP_COPY.failedTitle,
    ]);
    expect(renderedText(refusalAlert(document))).toBe(RSVP_REFUSAL_GENERIC_MESSAGE);

    const links = [...renderedElements(document, { tag: "a" })];
    const returnLinks = links.filter((link) => renderedText(link).trim() === "Return to the event");
    expect(returnLinks.map((link) => renderedAttribute(link, "href"))).toEqual(["/e/EVT"]);

    const backNav = [...renderedElements(document, { tag: "nav" })].find(
      (nav) => renderedAttribute(nav, "aria-label") === "Event calendar",
    );
    assert(backNav);
    expect(
      [...renderedElements(backNav, { tag: "a" })].map((link) => [
        renderedText(link).trim(),
        renderedAttribute(link, "href"),
      ]),
    ).toEqual([["← All events", "/events"]]);

    const head = elements(document).find((element) => element.tagName === "head");
    assert(head);
    const titles = head.childNodes.filter((node) => "tagName" in node && node.tagName === "title");
    expect(titles.map(textOf)).toEqual([`${RSVP_COPY.failedTitle} — Together We Own`]);
  });

  it("renders the throttled refusal with the announced wait", () => {
    const document = renderPage(429, "7");
    expect(renderedText(refusalAlert(document))).toBe(throttleWaitCopy(7));
    expectNoParsedCopy(document, RSVP_REFUSAL_GENERIC_MESSAGE);
  });

  it("escapes the message instead of rendering raw HTML", () => {
    const hostile = '</p><script>alert("xss")</script>';
    const model = rsvpRefusalModelFor({ status: 403, retryAfter: null, eventKey: "EVT" });
    const document = parseRenderedPage(renderRefusal({ ...model, message: hostile }));
    const alert = refusalAlert(document);
    expect(elements(alert)).toHaveLength(1);
    expect(textOf(alert)).toBe(hostile);

    const scripts = (root: Node) =>
      parsedElements(root)
        .filter((element) => element.tagName === "script")
        .map((script) => ({ attrs: script.attrs, text: textOf(script) }));
    expect(scripts(document)).toEqual(scripts(parseRenderedPage(renderRefusal(model))));
  });

  it("marks Events as the current location, like its Hono oracle", () => {
    const document = renderPage(403);
    const events = [...renderedElements(document, { tag: "a" })].filter(
      (link) => renderedText(link).trim() === "Events",
    );
    expect(
      events.map((link) => [
        renderedAttribute(link, "href"),
        renderedAttribute(link, "aria-current"),
      ]),
    ).toEqual([["/events", "location"]]);
    expect(
      parsedElements(document)
        .filter((element) => attr(element, "aria-current") === "page")
        .map((element) => textOf(element).trim()),
    ).not.toContain("Events");
  });

  it("keeps the served shell chrome: event theme, no account area, skip link", () => {
    const document = renderPage(503);
    const main = [...renderedElements(document, { tag: "main", id: "main" })];
    const [themedShell] = [...renderedElements(document, { tag: "div" })].filter(
      (div) => renderedAttribute(div, "data-theme") === "event",
    );
    expect(main).toHaveLength(1);
    expect(main[0]?.parentNode).toBe(themedShell);
    const allElements = parsedElements(document);
    expectNoParsedCopy(document, "Welcome, guest");
    expect(allElements.some((element) => attr(element, "aria-label") === "Account")).toBe(false);
    expect(allElements.some((element) => attr(element, "href")?.startsWith("/join/discord"))).toBe(
      false,
    );
    const skipLinks = [...renderedElements(document, { tag: "a" })].filter(
      (link) => renderedAttribute(link, "href") === "#main",
    );
    expect(skipLinks.map(renderedText)).toEqual(["Skip to content"]);
  });
});
