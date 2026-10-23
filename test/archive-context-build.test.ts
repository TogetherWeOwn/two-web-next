import { createRequire } from "node:module";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { archiveContext } from "../src/events/archive-context";

it("retains archive refusal and Unicode normalization after production tree-shaking", async () => {
  const requireWeb = createRequire(new URL("../web/package.json", import.meta.url).href);
  const { rolldown } = requireWeb("rolldown");
  const bundle = await rolldown({
    input: resolve("src/events/archive-context.ts"),
    platform: "node",
  });
  try {
    // Same conservative minification as the Kit SSR build, including tree-shaking.
    const { output } = await bundle.generate({
      format: "esm",
      minify: { compress: false, mangle: false, codegen: true },
    });
    const code = output.find((entry: { type: string }) => entry.type === "chunk").code;
    const compiled = await import(
      `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`
    );
    for (const search of [
      "?archivePage=2&archiveQuery=%",
      "?archivePage=2&archiveQuery=%FF",
      "?archivePage=2&archiveQuery=%E0%A4%A",
      "?archivePage=2&unrelated=%FF",
    ]) {
      expect(compiled.archiveContext(search), search).toBeNull();
    }
    for (const search of [
      "",
      "?archivePage=1",
      "?archivePage=2&archivePage=2",
      "?archivePage=02",
      ...[' \0Raid 🌌 "night" & <crew>\r\n ', "🌌".repeat(255), "🌌".repeat(256), "x�%+_"].map(
        (q) => `?${new URLSearchParams({ archivePage: "2", archiveQuery: q })}`,
      ),
    ]) {
      expect(compiled.archiveContext(search), search).toEqual(archiveContext(search));
    }
  } finally {
    await bundle.close();
  }
});
