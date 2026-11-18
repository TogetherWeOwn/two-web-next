// Enumerate already-parsed commands without executing them or interpreting shell
// syntax. Each command's ordered edges carry their original source locations.
// Projection inputs must be cloneable plain data, not YAML AST nodes. Projection
// preserves context for later analysis; it does not establish execution safety.
export function enumerateInvocationOccurrences(
  workflowCommands,
  scripts,
  project = (occurrence) => occurrence,
) {
  const occurrences = [];
  const maxWork = 10_000;
  const maxDepth = 128;
  let work = 0;

  function visit(command, root, edges, stack) {
    if (++work > maxWork) throw new Error("npm invocation expansion limit exceeded");
    occurrences.push(
      project(
        structuredClone({ origin: root.origin, command: command.location, npmEdges: edges }),
        structuredClone(command),
        structuredClone(root),
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
      for (const nested of scripts[edge.script]) visit(nested, root, nextEdges, nextStack);
    }
  }

  for (const command of workflowCommands) {
    visit(command, command, [], new Set());
  }
  return occurrences;
}
