#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMap, isScalar, parseDocument } from "yaml";
import { fenceMask, scanInlineLinks } from "./check-doc-links.mjs";

const workflowDir = ".github/workflows/";
const filename = String.raw`[A-Za-z0-9_.-]+\.ya?ml`;
const workflow = "`(?<workflow>(?:\\.github/workflows/)?" + filename + ")`";
const job = "`(?<job>[A-Za-z0-9_][A-Za-z0-9_ .()/&+:-]{0,99})`";
const actionsUrl = new RegExp(
  `^https://github\\.com/TogetherWeOwn/two-web-next/actions/workflows/(${filename})$`,
  "i",
);

// Check only explicit workflow/job pairs, in the forms used by the runbooks
// and CI guides. A bare YAML filename must identify a checked-in workflow.
const prosePatterns = [
  new RegExp(`${job} job in ${workflow}`, "g"),
  new RegExp(`${workflow}, job ${job}`, "g"),
  new RegExp(`\\(${workflow} ${job} job\\)`, "g"),
  new RegExp(`(?<![\\w-])(?<job>[A-Za-z_][\\w-]*) job \\(${workflow}\\)`, "g"),
  new RegExp(`^\\| *${job} job *\\|[^|]*\\| *${workflow}(?=[ ,|])`, "g"),
];
const labelJob = new RegExp(`${job} job`, "g");
const workflowPath = new RegExp(`^\\.github/workflows/${filename}$`);
const relativeWorkflow = new RegExp(`^(?:\\.\\.?/)*\\.github/workflows/${filename}$`);

function collectCitations(markdown, path, workflows) {
  const lines = markdown.split(/\r\n?|\n/);
  const fenced = fenceMask(lines);
  const visible = lines
    .map((line, index) => (fenced[index] ? "" : line))
    .join("\n")
    .replace(/<!--[\s\S]*?(?:-->|$)/g, (comment) => comment.replace(/[^\n]+/g, " "));
  const citations = [];
  for (const [index, line] of visible.split("\n").entries()) {
    if (!line.includes(".yml") && !line.includes(".yaml")) continue;
    // The link destination is authoritative, even if the label names another
    // workflow. Remove links before looking for the standalone prose forms.
    let prose = "";
    let end = 0;
    for (const link of scanInlineLinks(line)) {
      prose += line.slice(end, link.index) + " ";
      end = link.end;
      if (line[link.index] === "!") continue;
      const url = actionsUrl.exec(link.target);
      if (!url && !relativeWorkflow.test(link.target)) continue;
      const target = url
        ? workflowDir + url[1]
        : posix.normalize(posix.join(posix.dirname(path), link.target));
      if (!workflowPath.test(target)) continue;
      for (const match of link.text.matchAll(labelJob)) {
        citations.push({ line: index + 1, workflow: target, job: match.groups.job });
      }
    }
    prose += line.slice(end);
    for (const pattern of prosePatterns) {
      for (const match of prose.matchAll(pattern)) {
        const { workflow: cited, job } = match.groups;
        const target = cited.startsWith(workflowDir) ? cited : workflowDir + cited;
        if (!cited.startsWith(workflowDir) && !workflows.has(target)) continue;
        citations.push({ line: index + 1, workflow: target, job });
      }
    }
  }
  return citations;
}

function jobNames(source, path) {
  const document = parseDocument(source, { uniqueKeys: true });
  if (document.errors.length) throw new Error(`invalid YAML in ${path}`);
  const jobs = document.get("jobs", true);
  if (!isMap(jobs)) throw new Error(`expected a jobs mapping in ${path}`);
  const names = new Set();
  for (const { key, value } of jobs.items) {
    if (isScalar(key) && typeof key.value === "string") names.add(key.value);
    const name = isMap(value) ? value.get("name") : undefined;
    if (typeof name === "string" && !name.includes("${{")) names.add(name);
  }
  return names;
}

export function checkWorkflowJobCitations(root, baseline, output = console) {
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  const readBlob = (revision, path) => git("show", "--no-textconv", `${revision}:${path}`);
  try {
    const base = git("rev-parse", "--verify", "--end-of-options", `${baseline}^{commit}`).trim();
    const diff = git(
      "diff",
      "--name-status",
      "-z",
      "--no-ext-diff",
      "--find-renames",
      "--diff-filter=AMRT",
      base,
      "HEAD",
      "--",
      ":(icase,glob)**/*.md",
    );
    const fields = diff ? diff.slice(0, -1).split("\0") : [];
    const workflowsAt = (revision) =>
      new Set(
        git("ls-tree", "--name-only", "-z", revision, "--", workflowDir)
          .split("\0")
          .filter((path) => workflowPath.test(path)),
      );
    const baseWorkflows = fields.length ? workflowsAt(base) : new Set();
    const workflows = fields.length ? workflowsAt("HEAD") : new Set();
    const namesByWorkflow = new Map();
    const citationKey = ({ workflow, job }) => `${workflow}\0${job}`;
    let checked = 0;
    let broken = 0;
    for (let index = 0; index < fields.length; ) {
      const status = fields[index++];
      const oldPath = fields[index++];
      const path = status.startsWith("R") ? fields[index++] : oldPath;
      const previous = new Map();
      if (status !== "A") {
        for (const citation of collectCitations(readBlob(base, oldPath), oldPath, baseWorkflows)) {
          const key = citationKey(citation);
          previous.set(key, (previous.get(key) ?? 0) + 1);
        }
      }
      for (const citation of collectCitations(readBlob("HEAD", path), path, workflows)) {
        const key = citationKey(citation);
        const existing = previous.get(key) ?? 0;
        if (existing) {
          previous.set(key, existing - 1);
          continue;
        }
        checked += 1;
        if (!namesByWorkflow.has(citation.workflow)) {
          const names = workflows.has(citation.workflow)
            ? jobNames(readBlob("HEAD", citation.workflow), citation.workflow)
            : new Set();
          namesByWorkflow.set(citation.workflow, names);
        }
        if (namesByWorkflow.get(citation.workflow).has(citation.job)) continue;
        output.error(
          `${JSON.stringify(path)}:${citation.line}: missing job ${JSON.stringify(citation.job)} in ${citation.workflow}`,
        );
        broken += 1;
      }
    }
    output.log(`Workflow job citations checked: ${checked}, broken: ${broken}.`);
    return broken ? 1 : 0;
  } catch (error) {
    output.error(`Workflow job citation check failed: ${JSON.stringify(error.message)}`);
    return 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) {
    console.error("Usage: node ci/check-workflow-job-citations.mjs <baseline commit>");
    process.exitCode = 2;
  } else {
    process.exitCode = checkWorkflowJobCitations(process.cwd(), process.argv[2]);
  }
}
