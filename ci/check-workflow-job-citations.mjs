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
const softSpace = String.raw`(?:[ \t]+|[ \t]*\n[ \t]*)`;
const actionsUrl = new RegExp(
  `^https://github\\.com/TogetherWeOwn/two-web-next/actions/workflows/(${filename})$`,
  "i",
);

// Check only explicit workflow/job pairs, in the forms used by the runbooks
// and CI guides. A bare YAML filename must identify a checked-in workflow.
const prosePatterns = [
  new RegExp(`${job}${softSpace}job${softSpace}in${softSpace}${workflow}`, "g"),
  new RegExp(`${workflow}, job ${job}`, "g"),
  new RegExp(`\\(${workflow} ${job} job\\)`, "g"),
  new RegExp(`${job} job \\(${workflow}\\)`, "g"),
  new RegExp(`(?<![\\w\x60-])(?<job>[A-Za-z_]\\w*(?:-\\w+)+) job \\(${workflow}\\)`, "g"),
  new RegExp(`^\\| *${job} job *\\|[^|\\n]*\\| *${workflow}(?=[ ,|])`, "gm"),
];
const labelJob = new RegExp(`${job} job`, "g");
const workflowPath = new RegExp(`^\\.github/workflows/${filename}$`);
const relativeWorkflow = new RegExp(`^(?:\\.\\.?/)*\\.github/workflows/${filename}$`);

function maskCommentsAndExamples(text) {
  const tokens = [...text.matchAll(/<!--|-->|`+|\n[ \t]*\n/g)];
  const closingTicks = new Map();
  const ends = [];
  let commentEnd = text.length;
  // Match equal backtick runs in one pass, without searching the rest of the
  // document separately for each opener. Blank lines separate code spans.
  for (let index = tokens.length - 1; index >= 0; index--) {
    const [token] = tokens[index];
    const position = tokens[index].index;
    if (token === "-->") commentEnd = position + token.length;
    else if (token === "<!--") ends[index] = commentEnd;
    else if (token.startsWith("\n")) closingTicks.clear();
    else {
      ends[index] = closingTicks.get(token.length);
      closingTicks.set(token.length, position + token.length);
    }
  }
  let visible = "";
  let end = 0;
  for (const [index, token] of tokens.entries()) {
    const close = ends[index];
    if (close === undefined || token.index < end) continue;
    const raw = text.slice(token.index, close);
    const replacement = token[0] === "`" ? raw : raw.replace(/[^\n]+/g, "\u0000");
    visible += text.slice(end, token.index) + replacement;
    end = close;
  }
  return visible + text.slice(end);
}

function linkedWorkflow(destination, path) {
  const file = destination.split(/[?#]/, 1)[0];
  const url = actionsUrl.exec(file);
  if (url) return workflowDir + url[1];
  if (!relativeWorkflow.test(file)) return null;
  const target = posix.normalize(posix.join(posix.dirname(path), file));
  return workflowPath.test(target) ? target : null;
}

function collectCitations(markdown, path, workflows) {
  const lines = markdown.split(/\r\n?|\n/);
  const fenced = fenceMask(lines);
  const visible = maskCommentsAndExamples(
    lines.map((line, index) => (fenced[index] ? "" : line)).join("\n"),
  );
  const citations = [];
  const prose = visible
    .split("\n")
    .map((line, index) => {
      if (!line.includes("](")) return line;
      // The destination identifies the workflow, even when the label differs.
      // In prose, give a local workflow link the same form as its code citation.
      let text = "";
      let end = 0;
      for (const link of scanInlineLinks(line)) {
        text += line.slice(end, link.index);
        end = link.end;
        const target = line[link.index] === "!" ? null : linkedWorkflow(link.target, path);
        const labels = target ? [...link.text.matchAll(labelJob)] : [];
        for (const match of labels) {
          citations.push({ line: index + 1, workflow: target, job: match.groups.job });
        }
        text += target && labels.length === 0 ? "`" + target + "`" : "\u0000";
      }
      return text + line.slice(end);
    })
    .join("\n");
  for (const pattern of prosePatterns) {
    let line = 1;
    let offset = 0;
    for (const match of prose.matchAll(pattern)) {
      line += prose.slice(offset, match.index).split("\n").length - 1;
      offset = match.index;
      const { workflow: cited, job } = match.groups;
      const target = cited.startsWith(workflowDir) ? cited : workflowDir + cited;
      if (!cited.startsWith(workflowDir) && !workflows.has(target)) continue;
      citations.push({ line, workflow: target, job });
    }
  }
  return citations.sort((left, right) => left.line - right.line);
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
      "--no-textconv",
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
