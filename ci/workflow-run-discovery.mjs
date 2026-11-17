import { isMap, isScalar, isSeq, parseDocument } from "yaml";

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
