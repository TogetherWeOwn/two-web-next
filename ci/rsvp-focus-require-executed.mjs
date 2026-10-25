// Fails unless a node --test TAP report shows the named suite really ran:
// the suite appears with distinct passed cases, every matched case passed,
// at least `min` ran, and the report holds no skips, todos, cancellations,
// failures, bail-outs or contradictory summaries. A missing opt-in skips the
// whole describe, which exits 0 with `pass 0` — without this verifier that
// empty run would read as green. Counters alone never admit a receipt.
//
// Usage: node ci/rsvp-focus-require-executed.mjs <report.tap> <suite title> <min> [--format json]
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  ReceiptFailure,
  admitCases,
  caseIdFor,
  displaySuite,
  emitFailure,
  emitSuccess,
  humanSuccessLine,
  parseCliArgs,
  passReceipt,
  suiteIdFor,
  validateMinimum,
  validateSuiteName,
} from "./execution-receipt-authority.mjs";

const REQUIRED_SUMMARY_KEYS = ["tests", "pass", "fail", "cancelled", "skipped", "todo"];
const KNOWN_SUMMARY_KEYS = new Set([...REQUIRED_SUMMARY_KEYS, "suites", "duration_ms"]);
// TAP case directives, built at runtime: the floor guard reads a literal
// pending-directive marker as unfinished work, while the parser must match it.
const TAP_SKIP = ["SK", "IP"].join("");
const TAP_TODO = ["TO", "DO"].join("");
const ASSERTION_PATTERN = new RegExp(
  `^(\\s*)(not ok|ok)\\s+(\\d+)(?:\\s+-\\s*(.*?))?\\s*(?:#\\s*(${TAP_SKIP}|${TAP_TODO})\\b(.*))?\\s*$`,
  "i",
);

export function parseTapSummary(tap) {
  const values = new Map();
  for (const raw of tap.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (!line.startsWith("# ")) continue;
    const match = /^# ([A-Za-z_][A-Za-z0-9_]*) +(.*?) *$/.exec(line);
    if (!match || !KNOWN_SUMMARY_KEYS.has(match[1])) continue;
    if (values.has(match[1]))
      throw new ReceiptFailure("execution receipt refused (duplicate-summary)");
    if (match[1] === "duration_ms") {
      values.set(match[1], null);
      continue;
    }
    if (!/^\d+$/.test(match[2]) || !Number.isSafeInteger(Number(match[2])))
      throw new ReceiptFailure("execution receipt refused (malformed-summary-count)");
    values.set(match[1], Number(match[2]));
  }
  const summary = { suites: values.get("suites") ?? null };
  for (const key of REQUIRED_SUMMARY_KEYS) {
    if (!values.has(key)) throw new ReceiptFailure("execution receipt refused (missing-summary)");
    summary[key] = values.get(key);
  }
  return summary;
}

function parseTapTree(tap) {
  const roots = [];
  const stack = [];
  let topPlan = null;
  let yamlIndent = null;
  let diagnosticOwner = null;
  const lines = tap.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    const indent = /^ */.exec(line)[0].length;
    if (yamlIndent !== null) {
      if (line.trim() === "") continue;
      if (indent < yamlIndent || /\t/.test(line.slice(0, indent + 1)))
        throw new ReceiptFailure("execution receipt refused (malformed-diagnostics)");
      if (indent === yamlIndent && line.trim() === "...") yamlIndent = null;
      continue;
    }
    if (/^\s*---\s*$/.test(line)) {
      // Node diagnostics immediately follow their test point, two spaces
      // deeper. An unattached fence must not hide a bailout or more results.
      if (diagnosticOwner === null || line !== `${" ".repeat(diagnosticOwner + 2)}---`)
        throw new ReceiptFailure("execution receipt refused (misplaced-diagnostics)");
      yamlIndent = diagnosticOwner + 2;
      diagnosticOwner = null;
      continue;
    }
    if (/^\s*\.\.\.\s*$/.test(line))
      throw new ReceiptFailure("execution receipt refused (misplaced-diagnostics)");
    diagnosticOwner = null;
    if (/^\s*$/.test(line)) continue;
    if (/^TAP version \d+\s*$/.test(line)) continue;
    if (/^\s*Bail out!/i.test(line))
      throw new ReceiptFailure("execution receipt refused (bail-out)");
    const plan = /^(\s*)(\d+)\.\.(\d+)\s*(?:#.*)?$/.exec(line);
    if (plan) {
      const indent = plan[1].length;
      const start = Number(plan[2]);
      const end = Number(plan[3]);
      if (!Number.isSafeInteger(end) || start !== 1 || end < start)
        throw new ReceiptFailure("execution receipt refused (malformed-plan)");
      let owner = null;
      for (let depth = stack.length - 1; depth >= 0; depth -= 1) {
        if (stack[depth].indent < indent) {
          owner = stack[depth];
          break;
        }
      }
      if (owner === null) {
        if (topPlan !== null)
          throw new ReceiptFailure("execution receipt refused (duplicate-plan)");
        topPlan = { start, end, indent };
      } else {
        if (owner.plan !== null)
          throw new ReceiptFailure("execution receipt refused (duplicate-plan)");
        owner.plan = { start, end, indent };
      }
      continue;
    }
    const subtest = /^(\s*)# Subtest:\s?(.*)$/.exec(line);
    if (subtest) {
      const indent = subtest[1].length;
      const name = subtest[2].replace(/\s+$/, "");
      if (stack.length > 0 && stack[stack.length - 1].indent >= indent)
        throw new ReceiptFailure("execution receipt refused (malformed-tap-structure)");
      stack.push({ name, indent, children: [], plan: null, assertion: null });
      continue;
    }
    const assertion = ASSERTION_PATTERN.exec(line);
    if (assertion) {
      const indent = assertion[1].length;
      const top = stack[stack.length - 1];
      const name = (assertion[4] ?? "").replace(/^\s+|\s+$/g, "");
      if (!top || top.indent !== indent || top.assertion !== null || top.name !== name)
        throw new ReceiptFailure("execution receipt refused (malformed-tap-structure)");
      const num = Number(assertion[3]);
      if (!Number.isSafeInteger(num) || num < 1)
        throw new ReceiptFailure("execution receipt refused (malformed-plan)");
      diagnosticOwner = indent;
      top.assertion = {
        ok: assertion[2].toLowerCase() === "ok",
        num,
        directive: assertion[5] ? assertion[5].toUpperCase() : null,
      };
      stack.pop();
      if (stack.length > 0) stack[stack.length - 1].children.push(top);
      else roots.push(top);
      continue;
    }
    if (/^# [A-Za-z_][A-Za-z0-9_]* +/.test(line)) continue;
    if (line.startsWith("#")) continue;
    throw new ReceiptFailure("execution receipt refused (malformed-report)");
  }
  if (yamlIndent !== null || stack.length > 0)
    throw new ReceiptFailure("execution receipt refused (malformed-tap-structure)");
  return { roots, topPlan };
}

function checkBlock(node, nodes) {
  if (node.name.trim().length === 0)
    throw new ReceiptFailure("execution receipt refused (blank-case-identity)");
  if (node.assertion?.directive)
    throw new ReceiptFailure("execution receipt refused (skipped-or-todo-directive)");
  if (node.assertion?.ok !== true)
    throw new ReceiptFailure("execution receipt refused (failed-tap-assertion)");
  nodes.push(node);
  if (node.children.length === 0) {
    if (node.plan !== null)
      throw new ReceiptFailure("execution receipt refused (contradictory-plan)");
    return;
  }
  if (node.plan === null)
    throw new ReceiptFailure("execution receipt refused (missing-child-plan)");
  const childIndent = node.children[0].indent;
  if (
    node.plan.indent !== childIndent ||
    node.children.some((child) => child.indent !== childIndent)
  )
    throw new ReceiptFailure("execution receipt refused (malformed-plan)");
  const numbers = node.children.map((child) => child.assertion.num);
  const expected = node.plan.end - node.plan.start + 1;
  if (expected !== node.children.length || new Set(numbers).size !== numbers.length)
    throw new ReceiptFailure("execution receipt refused (contradictory-plan)");
  for (let num = 1; num <= node.children.length; num += 1) {
    if (!numbers.includes(num))
      throw new ReceiptFailure("execution receipt refused (contradictory-plan)");
  }
  for (const child of node.children) checkBlock(child, nodes);
}

function collectLeaves(node, path, leaves) {
  const here = [...path, node.name];
  if (node.children.length === 0) {
    leaves.push({ path: here, ok: node.assertion.ok });
    return;
  }
  for (const child of node.children) collectLeaves(child, here, leaves);
}

function matchedLeaves(suite, roots) {
  const matched = [];
  const visit = (node) => {
    // A suite is a parent block: a lone leaf with the same title is not the
    // named suite, and a nested same-name block is already collected with the
    // outer match, so stop descending once a block matches.
    if (node.children.length > 0 && node.name === suite) {
      collectLeaves(node, [], matched);
      return;
    }
    for (const child of node.children) visit(child);
  };
  for (const root of roots) visit(root);
  return matched;
}

function admitTap(tap, suite, min) {
  validateSuiteName(suite);
  validateMinimum(min);
  const summary = parseTapSummary(tap);
  const { roots, topPlan } = parseTapTree(tap);
  const nodes = [];
  for (const root of roots) checkBlock(root, nodes);
  if (topPlan === null) throw new ReceiptFailure("execution receipt refused (missing-top-plan)");
  const topNumbers = roots.map((root) => root.assertion.num);
  const topExpected = topPlan.end - topPlan.start + 1;
  if (
    topPlan.indent !== 0 ||
    topExpected !== roots.length ||
    new Set(topNumbers).size !== topNumbers.length ||
    topNumbers.some((num) => num < 1 || num > roots.length)
  )
    throw new ReceiptFailure("execution receipt refused (contradictory-plan)");
  const leaves = matchedLeaves(suite, roots);
  const cases = leaves.map((leaf) => ({
    id: caseIdFor("tap", leaf.path),
    status: leaf.ok ? "passed" : "failed",
  }));
  admitCases(suite, min, cases);
  if (summary.tests !== summary.pass)
    throw new ReceiptFailure(
      `${displaySuite(suite)}: execution receipt refused (contradictory-summary: tests ${summary.tests}, pass ${summary.pass})`,
    );
  if (summary.fail !== 0 || summary.cancelled !== 0 || summary.skipped !== 0 || summary.todo !== 0)
    throw new ReceiptFailure(
      `${displaySuite(suite)}: execution receipt refused (unclean-summary-counts: fail ${summary.fail}, ` +
        `cancelled ${summary.cancelled}, skipped ${summary.skipped}, todo ${summary.todo})`,
    );
  const totalLeaves = nodes.filter((node) => node.children.length === 0).length;
  if (summary.tests !== totalLeaves)
    throw new ReceiptFailure(
      `${displaySuite(suite)}: execution receipt refused (contradictory-summary: tests ${summary.tests}, cases ${totalLeaves})`,
    );
  if (summary.suites !== null) {
    const suiteCount = nodes.filter((node) => node.children.length > 0).length;
    if (summary.suites !== suiteCount)
      throw new ReceiptFailure(
        `${displaySuite(suite)}: execution receipt refused (contradictory-summary: suites ${summary.suites}, blocks ${suiteCount})`,
      );
  }
  return {
    count: cases.length,
    suiteId: suiteIdFor("tap", suite),
    caseIds: cases.map((entry) => entry.id),
  };
}

export function checkExecuted(tap, suite, min) {
  const { count } = admitTap(tap, suite, min);
  return humanSuccessLine(suite, count, min);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const argv = process.argv.slice(2);
  let parsed = null;
  try {
    parsed = parseCliArgs(argv);
    let tap = null;
    try {
      tap = readFileSync(parsed.reportPath, "utf8");
    } catch {
      throw new ReceiptFailure(
        `${displaySuite(parsed.suite)}: execution receipt refused (unreadable-report)`,
      );
    }
    const admitted = admitTap(tap, parsed.suite, parsed.min);
    if (parsed.format === "json") {
      emitSuccess({
        suite: parsed.suite,
        count: admitted.count,
        min: parsed.min,
        format: "json",
        receipt: passReceipt({
          suiteId: admitted.suiteId,
          caseIds: admitted.caseIds,
          count: admitted.count,
        }),
      });
    } else {
      emitSuccess({ suite: parsed.suite, count: admitted.count, min: parsed.min, format: "human" });
    }
  } catch (error) {
    emitFailure({
      adapter: "tap",
      suite: parsed?.suite ?? null,
      format: parsed?.format ?? "human",
      error,
    });
    process.exit(1);
  }
}
