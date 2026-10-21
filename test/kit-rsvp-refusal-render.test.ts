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

describe("Kit RSVP refusal presentation", () => {
  it("renders the generic refusal with the back nav, heading, alert and return link", () => {
    const html = renderRefusal(
      rsvpRefusalModelFor({ status: 403, retryAfter: null, eventKey: "EVT" }),
    );
    expect(html).toContain(`<h1>${RSVP_COPY.failedTitle}</h1>`);
    expect(html).toContain('role="alert"');
    expect(html).toContain(RSVP_REFUSAL_GENERIC_MESSAGE);
    expect(html).toContain('href="/e/EVT"');
    expect(html).toContain("Return to the event");
    expect(html).toContain('aria-label="Event calendar"');
    expect(html).toContain(`<title>${RSVP_COPY.failedTitle} — Together We Own</title>`);
  });

  it("renders the throttled refusal with the announced wait", () => {
    const html = renderRefusal(
      rsvpRefusalModelFor({ status: 429, retryAfter: "7", eventKey: "EVT" }),
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain(throttleWaitCopy(7));
    expect(html).not.toContain(RSVP_REFUSAL_GENERIC_MESSAGE);
  });

  it("escapes the message instead of rendering raw HTML", () => {
    const hostile = '</p><script>alert("xss")</script>';
    const html = renderRefusal({
      title: RSVP_COPY.failedTitle,
      message: hostile,
      returnPath: "/e/EVT",
    });
    expect(html).not.toContain("</p><script>");
    expect(html).toContain("alert(");
    expect(html).toContain('role="alert"');
  });

  it("marks Events as the current location, like its Hono oracle", () => {
    const html = renderRefusal(
      rsvpRefusalModelFor({ status: 403, retryAfter: null, eventKey: "EVT" }),
    );
    expect(html).toContain('<a href="/events" aria-current="location">Events</a>');
    expect(html).not.toContain('aria-current="page">Events');
  });

  it("keeps the served shell chrome: event theme, no account area, skip link", () => {
    const html = renderRefusal(
      rsvpRefusalModelFor({ status: 503, retryAfter: null, eventKey: "EVT" }),
    );
    expect(html).toContain('data-theme="event"');
    expect(html).not.toContain("Welcome, guest");
    expect(html).not.toContain('href="/join/discord');
    expect(html).toContain('href="#main"');
  });
});
