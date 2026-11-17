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
    if (steps == null && job.value.has("uses")) continue;
    if (!isSeq(steps)) throw new Error(`${name}: invalid steps`);
    for (const [stepIndex, step] of steps.items.entries()) {
      if (!isMap(step)) throw new Error(`${name}: invalid step`);
      const run = step.get("run", true);
      if (run == null) continue;
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

// Enumerate already-parsed commands without executing them or interpreting shell
// syntax. Each command's ordered edges carry their original source locations.
// The optional projection sees the original command, workflow root and ordered
// parent commands and script indexes on every path. An index identifies the
// preceding commands in that script without copying potentially large prefixes.
// None establishes that execution is safe.
export function enumerateInvocationOccurrences(
  workflowCommands,
  scripts,
  project = (occurrence) => occurrence,
) {
  const occurrences = [];
  const maxWork = 10_000;
  const maxDepth = 128;
  let work = 0;

  function visit(command, root, edges, stack, parents, scriptPath) {
    if (++work > maxWork) throw new Error("npm invocation expansion limit exceeded");
    occurrences.push(
      project(
        { origin: root.origin, command: command.location, npmEdges: edges },
        command,
        root,
        [...parents],
        scriptPath.map((frame) => ({ ...frame })),
      ),
    );
    for (const edge of command.npmEdges) {
      if (++work > maxWork) throw new Error("npm invocation expansion limit exceeded");
      if (stack.size >= maxDepth) throw new Error("npm invocation depth limit exceeded");
      if (!Object.hasOwn(scripts, edge.script)) {
        throw new Error(`Unknown npm script: ${edge.script}`);
      }
      if (stack.has(edge.script)) {
        throw new Error(`npm script cycle: ${[...stack, edge.script].join(" -> ")}`);
      }
      const nextStack = new Set(stack);
      nextStack.add(edge.script);
      const nextEdges = [...edges, { ...edge }];
      const nextParents = [...parents, command];
      for (const [index, nested] of scripts[edge.script].entries()) {
        visit(nested, root, nextEdges, nextStack, nextParents, [
          ...scriptPath,
          { script: edge.script, index },
        ]);
      }
    }
  }

  for (const command of workflowCommands) {
    visit(command, command, [], new Set(), [], []);
  }
  return occurrences;
}
