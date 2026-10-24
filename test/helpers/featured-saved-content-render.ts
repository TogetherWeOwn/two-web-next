// Execute the checked-in Svelte SSR leaf, never a test-built imitation of its markup.
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { build } from "esbuild";
import { FeaturedFormPage } from "../../src/admin/pages/featured-form";
import { resolveKitFeaturedEdit } from "../../src/admin/kit-featured-edit";
import type { FeaturedEditRow } from "../../src/admin/store-featured";
import type { Db } from "../../src/db";
import { APP_URL, CHECKED_AT } from "./featured-saved-content-cases";

const root = process.cwd();
const webRequire = createRequire(path.join(root, "web/package.json"));
let kitRenderer: Promise<(view: unknown) => string> | undefined;

function compiledKitRenderer() {
  return (kitRenderer ??= (async () => {
    const { compile } = webRequire("svelte/compiler");
    const result = await build({
      stdin: {
        contents: `import { render } from 'svelte/server';
          import Page from './web/src/routes/admin/featured/[id]/+page.svelte';
          export const renderView = (view) => {
            const result = render(Page, { props: { data: { view } } });
            return result.head + result.body;
          };`,
        resolveDir: root,
      },
      bundle: true,
      platform: "node",
      format: "esm",
      write: false,
      logLevel: "silent",
      tsconfigRaw: {},
      nodePaths: [path.join(root, "web/node_modules"), path.join(root, "node_modules")],
      alias: { "#lib": path.join(root, "web/src/lib") },
      plugins: [
        {
          name: "saved-featured-real-ssr",
          setup(builder) {
            builder.onLoad({ filter: /\.svelte$/ }, async ({ path: filename }) => {
              const source = await readFile(filename, "utf8");
              return {
                contents: compile(source, { filename, generate: "server" }).js.code,
                loader: "js",
                resolveDir: path.dirname(filename),
              };
            });
          },
        },
      ],
    });
    const encoded = Buffer.from(result.outputFiles[0]!.text).toString("base64");
    const module = await import(`data:text/javascript;base64,${encoded}`);
    return module.renderView as (view: unknown) => string;
  })());
}

export function savedValues(row: FeaturedEditRow): Record<string, unknown> {
  return {
    title: row.title,
    body: row.body ?? "",
    url: row.url ?? "",
    image_url: row.imageUrl ?? "",
    image_alt: row.imageAlt ?? "",
    is_published: row.isPublished ? "on" : "",
    position: String(row.position),
    starts_at: row.startsAtText ?? "",
    ends_at: row.endsAtText ?? "",
  };
}

export async function renderSavedHono(
  row: FeaturedEditRow,
  options: {
    values?: Record<string, unknown>;
    errors?: Record<string, string>;
    imageHosts?: string;
  } = {},
): Promise<string> {
  return await FeaturedFormPage({
    mode: "edit",
    row,
    values: options.values ?? savedValues(row),
    errors: options.errors ?? {},
    now: CHECKED_AT,
    appUrl: APP_URL,
    imageHosts: options.imageHosts,
  }).toString();
}

export async function renderSavedKit(row: FeaturedEditRow, imageHosts?: string): Promise<string> {
  // Any accidental query/write outside the supplied keyed read fails immediately.
  const noOtherDatabaseAccess = new Proxy({} as Db, {
    get(_target, property) {
      throw new Error(`Unexpected preview database access: ${String(property)}`);
    },
  });
  const outcome = await resolveKitFeaturedEdit(String(row.id), {
    db: noOtherDatabaseAccess,
    get: async (_db, id) => {
      if (id !== row.id) throw new Error("Wrong saved row requested");
      return row;
    },
    now: CHECKED_AT,
    appUrl: APP_URL,
    imageHosts,
  });
  if (outcome.kind !== "ok") throw new Error(`Fixture admission failed: ${outcome.kind}`);
  return (await compiledKitRenderer())(outcome.view);
}
