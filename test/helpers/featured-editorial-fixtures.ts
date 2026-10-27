// Test Author owned. Expectations are hand-counted; validators are an independent
// oracle, never the source of expected UI counts. No database or live endpoints.
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { FeaturedFormPage } from "../../src/admin/pages";
import { resolveKitFeaturedEdit } from "../../src/admin/kit-featured-edit";
import { parseFeaturedForm, ValidationError } from "../../src/admin/validation";
import { compileKitForms, featuredRow, now, root } from "./admin-validation-correction";

export { compileKitForms, root };
export type Compiler = Awaited<ReturnType<typeof compileKitForms>>;
export type Surface = "Hono" | "Kit";
export type Mode = "new" | "edit";
export const fields = ["title", "body", "image_alt", "url", "image_url"] as const;
export type Field = (typeof fields)[number];
export const budgets: Record<Field, number> = {
  title: 255,
  body: 1000,
  image_alt: 255,
  url: 255,
  image_url: 255,
};
export const saved = {
  title: "Game night",
  body: "Bring friends.",
  image_alt: "Friends playing",
  url: "https://example.test/games",
  image_url: "https://cdn.discordapp.com/photo.png",
  position: "2",
  starts_at: "",
  ends_at: "",
  is_published: "on",
};
export const empty = Object.fromEntries(Object.keys(saved).map((key) => [key, ""]));

export function errorsFor(values: Record<string, string>): Record<string, string> {
  try {
    parseFeaturedForm(values);
    return {};
  } catch (error) {
    if (!(error instanceof ValidationError)) throw error;
    return error.fields;
  }
}

export async function documentFixture(
  compiler: Compiler,
  surface: Surface,
  mode: Mode,
  values: Record<string, string> = mode === "new" ? empty : saved,
  errors: Record<string, string> = {},
) {
  const path = mode === "new" ? "/admin/featured/new" : "/admin/featured/7";
  const action = mode === "new" ? "/admin/featured" : "/admin/featured/7";
  const row = {
    ...featuredRow,
    title: values.title!,
    body: values.body || null,
    imageAlt: values.image_alt || null,
    url: values.url || null,
    imageUrl: values.image_url || null,
    position: Number(values.position || 0),
    isPublished: values.is_published === "on",
  };
  let data: unknown = {};
  if (surface === "Kit" && mode === "edit") {
    const result = await resolveKitFeaturedEdit("7", {
      db: {} as never,
      get: async () => ({ ...row, startsAtText: null, endsAtText: null }),
      now,
    });
    if (result.kind !== "ok") throw new Error("Invalid editorial fixture");
    data = { view: result.view };
  }
  const html =
    surface === "Hono"
      ? String(FeaturedFormPage({ mode, row, values, errors, now, appUrl: "https://example.test" }))
      : compiler.renderForm(mode === "new" ? 2 : 3, data);
  return { html, data, path, action, surface, mode, values };
}

export const textCases = (limit: number) => [
  { label: "ASCII at limit", value: "x".repeat(limit), used: limit, over: false },
  { label: "ASCII over limit", value: "x".repeat(limit + 1), used: limit + 1, over: true },
  { label: "astral is not UTF-16", value: "😀".repeat(128), used: 128, over: false },
  { label: "astral at limit", value: ` \t${"😀".repeat(limit)}  `, used: limit, over: false },
  { label: "astral over limit", value: "😀".repeat(limit + 1), used: limit + 1, over: true },
  {
    label: "combining marks are not graphemes",
    value: "é".repeat(Math.floor(limit / 2)) + (limit % 2 ? "x" : ""),
    used: limit,
    over: false,
  },
  {
    label: "combining over limit",
    value: "é".repeat(Math.floor(limit / 2)) + (limit % 2 ? "xx" : "x"),
    used: limit + 1,
    over: true,
  },
  { label: "trimmed whitespace", value: " \t é😀   ", used: 3, over: false },
];
type UrlCase = { label: string; value: string; used: number; over: boolean; refusal?: string };
export function urlCases(field: "url" | "image_url"): UrlCase[] {
  const prefix = field === "url" ? "https://example.test/" : "https://cdn.discordapp.com/";
  const boundary = prefix + "x".repeat(255 - prefix.length - 2) + "😀";
  // `over` is the length verdict after trimming. The server inspects a submitted
  // link before trimming, so its edge tab is refused as a control character;
  // the image URL is trimmed first and stays accepted.
  const trimmedRefusal = field === "url" ? "Link cannot contain control characters." : undefined;
  return [
    { label: "255 UTF-16 units", value: boundary, used: 255, over: false },
    { label: "256 units but 255 code points", value: `${boundary}x`, used: 256, over: true },
    {
      label: "trimmed URL",
      value: ` \t${boundary}  `,
      used: 255,
      over: false,
      refusal: trimmedRefusal,
    },
  ];
}

// Compile real Svelte browser code as well as SSR. No fake DOM, component stub,
// mutation action, or test-only production export. Hydration keeps native forms.
export async function compileFeaturedClients(): Promise<Record<Mode, string>> {
  const webRequire = createRequire(join(root, "web/package.json"));
  const { compile } = webRequire("svelte/compiler");
  const result = {} as Record<Mode, string>;
  for (const mode of ["new", "edit"] as const) {
    const page = join(
      root,
      `web/src/routes/admin/featured/${mode === "new" ? "new" : "[id]"}/+page.svelte`,
    );
    const output = await build({
      stdin: {
        contents: `import {hydrate} from 'svelte'; import Page from ${JSON.stringify(page)};
hydrate(Page,{target:document.getElementById('kit-root'),props:{data:window.fixtureData}});
window.kitMounted=true;`,
        resolveDir: root,
        sourcefile: "editorial-client.mjs",
      },
      bundle: true,
      write: false,
      format: "iife",
      platform: "browser",
      conditions: ["browser"],
      nodePaths: [join(root, "web/node_modules"), join(root, "node_modules")],
      alias: { "#lib": join(root, "web/src/lib") },
      logLevel: "silent",
      plugins: [
        {
          name: "editorial-client",
          setup(plugin) {
            plugin.onLoad({ filter: /\.svelte$/ }, ({ path }) => ({
              contents: compile(readFileSync(path, "utf8"), {
                generate: "client",
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
    result[mode] = output.outputFiles[0]!.text;
  }
  return result;
}
