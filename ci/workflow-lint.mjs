import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isAlias, isMap, isScalar, parseDocument, visit } from "yaml";

// actionlint 1.7.12 does not yet parse concurrency.queue. Validate that
// extension separately, then lint every other byte with the pinned validator.
// Remove this projection once upstream actionlint supports queue natively.
export function projectWorkflow(source) {
  const document = parseDocument(source, { uniqueKeys: true });
  if (document.errors.length) throw new Error(document.errors[0].message);
  if (!isMap(document.contents)) throw new Error("workflow must be a mapping");
  const owners = [document.contents];
  const jobs = document.get("jobs", true);
  if (isMap(jobs)) {
    for (const pair of jobs.items) if (isMap(pair.value)) owners.push(pair.value);
  }
  const ranges = [];
  for (const owner of owners) {
    const concurrency = owner.get("concurrency", true);
    if (!isMap(concurrency) || !concurrency.has("queue")) continue;
    if (concurrency.flow) throw new Error("queue requires block-style concurrency");
    const queue = concurrency.items.find((pair) => pair.key?.value === "queue");
    if (
      !isScalar(queue.value) ||
      queue.value.type !== "PLAIN" ||
      !["single", "max"].includes(queue.value.value)
    )
      throw new Error("concurrency.queue must be plain single or max");
    const cancel = concurrency.get("cancel-in-progress", true);
    if (cancel !== undefined && (!isScalar(cancel) || cancel.value !== false)) {
      throw new Error("concurrency.queue requires cancel-in-progress false or absent");
    }
    ranges.push([queue.key.range[0], queue.value.range[2]]);
  }
  if (!ranges.length) return source;
  // Aliases/merges can conceal or share an extension outside its validated
  // owner. Fail closed rather than expanding YAML and changing lint coverage.
  visit(document, {
    Node(_key, node) {
      if (isAlias(node) || node.anchor)
        throw new Error("queue workflows cannot use YAML aliases or anchors");
    },
    Pair(_key, pair) {
      if (isScalar(pair.key) && pair.key.value === "<<")
        throw new Error("queue workflows cannot use YAML merges");
    },
  });
  let projected = source;
  for (const [start, end] of ranges.sort((a, b) => b[0] - a[0])) {
    projected =
      projected.slice(0, start) +
      projected.slice(start, end).replace(/[^\r\n]/g, " ") +
      projected.slice(end);
  }
  return projected;
}

export function lintWorkflows(binary, paths, run = spawnSync) {
  if (!paths.length) throw new Error("no workflow files found");
  let failed = false;
  for (const file of paths) {
    try {
      const input = projectWorkflow(readFileSync(file, "utf8"));
      const result = run(binary, ["-shellcheck=", "-pyflakes=", "-stdin-filename", file, "-"], {
        input,
        encoding: "utf8",
        maxBuffer: 8 * 1024 * 1024,
      });
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      if (result.error) throw result.error;
      if (result.status !== 0) failed = true;
    } catch (error) {
      console.error(`${file}: ${error.message}`);
      failed = true;
    }
  }
  return failed ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const binary = process.argv[2];
  if (!binary) throw new Error("usage: node ci/workflow-lint.mjs <actionlint binary>");
  const paths = readdirSync(".github/workflows")
    .filter((name) => /\.ya?ml$/.test(name))
    .sort()
    .map((name) => `.github/workflows/${name}`);
  process.exitCode = lintWorkflows(binary, paths);
}
