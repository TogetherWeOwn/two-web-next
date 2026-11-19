import { readFileSync } from "node:fs";
import type { PluginBuild } from "esbuild";

export function collectImportedCss(plugin: PluginBuild, styles: string[]) {
  plugin.onLoad({ filter: /\.css$/ }, ({ path }) => {
    styles.push(readFileSync(path, "utf8"));
    return { contents: "", loader: "js" };
  });
}
