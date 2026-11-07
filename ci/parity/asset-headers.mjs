// Supplemental built-asset rows. Shared route/static goldens still compare full
// responses. Kit-only output has no Hono body counterpart: compare its security
// headers with Hono at the same URL, retaining both complete responses as evidence.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { compareRecordings } from "./compare.mjs";
import { listPublicFiles, slug } from "./vectors.mjs";

function assetFile(path) {
  if (path !== "/_app/version.json" && !path.startsWith("/_app/immutable/"))
    throw new Error(`Not an adapter pre-hook asset: ${path}`);
  return `static/${slug(path)}`;
}

export function productionAssetPaths(directory, sourceHeaders) {
  const generatedHeaders = readFileSync(join(directory, "_headers"), "utf8");
  // The adapter inserts its generated cache/robots rules into this block.
  // Require every reviewed non-comment line; the runtime rows below verify
  // their effective values after Cloudflare combines overlapping rules.
  const reviewed = sourceHeaders
    .split("\n")
    .filter((line) => line.trim() && !line.trim().startsWith("#"));
  if (!reviewed.includes("/_app/*") || !reviewed.every((line) => generatedHeaders.includes(line)))
    throw new Error("Built adapter _headers does not retain the reviewed /_app security policy");
  const paths = listPublicFiles(join(directory, "_app")).map((path) => `/_app${path}`);
  if (!paths.includes("/_app/version.json") || !paths.some((p) => p.startsWith("/_app/immutable/")))
    throw new Error("Built adapter must contain version.json and immutable assets");
  return paths.filter(
    (path) => path === "/_app/version.json" || path.startsWith("/_app/immutable/"),
  );
}

export function compareProductionRecordings(baseline, candidate, paths, headerNames, exceptions) {
  if (!paths.length || !headerNames.length || !headerNames.includes("content-security-policy"))
    throw new Error("Asset parity requires built paths and the complete security policy");
  const files = new Set(paths.map(assetFile));
  if (files.size !== paths.length) throw new Error("Built asset parity paths collide");
  const shared = (recording) => new Map([...recording].filter(([file]) => !files.has(file)));
  const comparison = compareRecordings(shared(baseline), shared(candidate), exceptions);
  const rows = [];
  const failures = [];
  for (const path of paths) {
    const file = assetFile(path);
    const a = baseline.get(file) ?? {};
    const b = candidate.get(file) ?? {};
    for (const id of new Set(["GET", "HEAD", ...Object.keys(a), ...Object.keys(b)])) {
      const key = `${file}#${id}`;
      if (!a[id] || !b[id]) {
        failures.push({
          key,
          field: "missing",
          baseline: Boolean(a[id]),
          candidate: Boolean(b[id]),
        });
        continue;
      }
      const original = a[id].response;
      const built = b[id].response;
      if (["GET", "HEAD"].includes(id) && built.status !== 200)
        failures.push({ key, field: "asset.status", baseline: 200, candidate: built.status });
      const pick = (response) =>
        Object.fromEntries(headerNames.map((name) => [name, response.headers[name] ?? null]));
      rows.push({
        key,
        path,
        baselineStatus: original.status,
        candidateStatus: built.status,
        baseline: pick(original),
        candidate: pick(built),
      });
      for (const name of headerNames) {
        const before = original.headers[name];
        const after = built.headers[name];
        // Missing on both sides must not turn an absent security header into a PASS.
        if (typeof before !== "string" || before !== after)
          failures.push({
            key,
            field: `headers.${name}`,
            baseline: before ?? null,
            candidate: after ?? null,
          });
      }
    }
  }
  return { comparison, assets: { paths, headerNames, rows, failures } };
}
