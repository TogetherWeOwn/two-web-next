import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { createVitest } from "vitest/node";

// Vitest 5 writes a Flatted tuple with file and coverage references.
// Vitest itself decodes and replays the complete report after this check.
function blobPaths(content, filename) {
  const table = JSON.parse(content);
  if (!Array.isArray(table) || !Array.isArray(table[0])) {
    throw new Error(`${filename}: invalid Vitest blob tuple`);
  }
  function dereference(key) {
    if (typeof key !== "string" || !/^[1-9]\d*$/.test(key) || !Object.hasOwn(table, key)) {
      throw new Error(`${filename}: invalid Vitest blob reference`);
    }
    return table[key];
  }
  const files = dereference(table[0]?.[1]);
  if (!Array.isArray(files)) throw new Error(`${filename}: invalid Vitest file table`);
  if (requireCoverage) {
    const map = table[0][3] == null ? null : dereference(table[0][3]);
    if (!map || typeof map !== "object" || Array.isArray(map) || !Object.keys(map).length) {
      throw new Error(`${filename}: missing or empty coverage map`);
    }
  }
  return files.map((ref) => {
    const filepath = dereference(dereference(ref)?.filepath);
    if (typeof filepath !== "string") throw new Error(`${filename}: invalid Vitest filepath`);
    return filepath;
  });
}

async function coverageReports(dir) {
  const files = await readdir(dir, { withFileTypes: true });
  const expected = [1, 2, 3].map((shard) => `vitest-${shard}.json`);
  if (files.length === 3 && files.every((file) => file.isFile() && expected.includes(file.name))) {
    return expected.map((name) => join(dir, name));
  }
  throw new Error(`${dir}: expected exactly three regular Vitest reports`);
}

const requireCoverage = process.argv[2] === "--coverage-dir";
const reports = requireCoverage ? await coverageReports(process.argv[3]) : process.argv.slice(2);
for (const [index, filename] of reports.entries()) {
  const paths = blobPaths(await readFile(filename, "utf8"), filename);
  const vitest = await createVitest({ watch: false, shard: `${index + 1}/${reports.length}` });
  try {
    // `vitest list --filesOnly` discovers tests but does not apply the sequencer.
    const sequencer = new vitest.config.sequence.sequencer(vitest);
    const specs = await sequencer.shard(await vitest.getRelevantTestSpecifications());
    const missing = new Set(specs.map((spec) => spec.moduleId));
    if (missing.size === 0) {
      throw new Error(`${filename}: Vitest discovered no files for this shard`);
    }
    const extra = paths.filter((path) => !missing.delete(path));
    if (missing.size || extra.length) {
      const names = (paths) =>
        Array.from(paths, (path) => relative(process.cwd(), path)).join(", ") || "none";
      throw new Error(
        `${filename}: Vitest inventory mismatch (missing: ${names(missing)}; unexpected or duplicate: ${names(extra)})`,
      );
    }
  } finally {
    await vitest.close();
  }
}
