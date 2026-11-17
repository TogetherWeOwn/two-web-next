// Enumerate already-parsed commands without executing them or interpreting shell
// syntax. Each command's ordered edges carry their original source locations.
// The optional projection sees the original command, workflow root and ordered
// parent commands and script indexes on every path. An index identifies the
// preceding commands in that script without copying potentially large prefixes.
// Projection inputs must be cloneable data; structured cloning does not preserve
// custom prototypes. Keep YAML AST nodes outside these inputs and adapt their
// needed fields to plain data. None establishes that execution is safe.
export function enumerateInvocationOccurrences(
  workflowCommands,
  scripts,
  project = (occurrence) => occurrence,
) {
  const occurrences = [];
  const maxWork = 10_000;
  const maxDepth = 128;
  let work = 0;

  // Reject non-cloneable metadata rather than sharing it with a projection.
  const copyCommand = (command) => structuredClone(command);

  function visit(command, root, edges, stack, parents, scriptPath) {
    if (++work > maxWork) throw new Error("npm invocation expansion limit exceeded");
    occurrences.push(
      project(
        structuredClone({
          origin: root.origin,
          command: command.location,
          npmEdges: edges,
        }),
        copyCommand(command),
        copyCommand(root),
        parents.map(copyCommand),
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
