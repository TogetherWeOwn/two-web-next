import { isMap, isScalar, isSeq, parseDocument } from "yaml";

// Convert only an unambiguous YAML data tree; aliases, tags, merge keys and
// complex mapping keys need separate semantic analysis and are rejected.
export function workflowRunPlainData(run) {
  // Match the occurrence projector's depth limit: only leaves fit at 128.
  const maxProjectionDepth = 128;
  let count = 0;
  function convert(node, depth) {
    if (
      ++count > 100_000 ||
      !node ||
      node.tag ||
      (depth >= maxProjectionDepth && !isScalar(node))
    ) {
      throw new Error(`${run.origin.workflow}: unsupported workflow data`);
    }
    if (isScalar(node)) {
      const value = node.value;
      if (value === null || typeof value === "string" || typeof value === "boolean") return value;
      if (typeof value === "number" && Number.isFinite(value)) return value;
    } else if (isSeq(node)) {
      return node.items.map((item) => convert(item, depth + 1));
    } else if (isMap(node)) {
      const result = {};
      for (const pair of node.items) {
        const key = convert(pair.key, depth + 1);
        if (typeof key !== "string" || key === "<<" || Object.hasOwn(result, key)) {
          throw new Error(`${run.origin.workflow}: unsupported workflow mapping key`);
        }
        Object.defineProperty(result, key, {
          value: convert(pair.value, depth + 1),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      return result;
    }
    throw new Error(`${run.origin.workflow}: unsupported workflow data`);
  }
  // Count the command and context wrappers, plus the preceding-steps array.
  return {
    origin: { ...run.origin },
    run: run.run,
    workflow: convert(run.workflow, 2),
    job: convert(run.job, 2),
    step: convert(run.step, 2),
    precedingSteps: run.precedingSteps.map((step) => convert(step, 3)),
  };
}

// Preserve the complete preceding step nodes for later independent context
// inspection. Discovery alone is not evidence that a step ran or succeeded.
export function discoverWorkflowRuns(name, text) {
  const doc = parseDocument(text);
  if (doc.errors.length) throw new Error(`${name}: invalid workflow YAML`);
  if (!isMap(doc.contents)) throw new Error(`${name}: invalid workflow root`);
  const jobs = doc.contents.get("jobs", true);
  if (!isMap(jobs)) throw new Error(`${name}: invalid jobs`);
  const runs = [];
  for (const [jobIndex, job] of jobs.items.entries()) {
    if (!isScalar(job.key) || typeof job.key.value !== "string" || !isMap(job.value)) {
      throw new Error(`${name}: invalid job`);
    }
    const steps = job.value.get("steps", true);
    if (!job.value.has("steps") && job.value.has("uses")) {
      const uses = job.value.get("uses", true);
      if (!isScalar(uses) || typeof uses.value !== "string") {
        throw new Error(`${name}: invalid reusable job uses`);
      }
      continue;
    }
    if (!isSeq(steps)) throw new Error(`${name}: invalid steps`);
    for (const [stepIndex, step] of steps.items.entries()) {
      if (!isMap(step)) throw new Error(`${name}: invalid step`);
      const run = step.get("run", true);
      if (!step.has("run")) continue;
      if (!isScalar(run) || typeof run.value !== "string") {
        throw new Error(`${name}: invalid run`);
      }
      runs.push({
        origin: { workflow: name, job: jobIndex, step: stepIndex },
        run: run.value,
        workflow: doc.contents,
        job: job.value,
        step,
        precedingSteps: steps.items.slice(0, stepIndex),
      });
    }
  }
  return runs;
}
