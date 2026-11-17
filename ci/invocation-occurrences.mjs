// Enumerate already-parsed commands without executing them or interpreting shell
// syntax. Each command's ordered edges carry their original source locations.
export function enumerateInvocationOccurrences(workflowCommands, scripts) {
  const occurrences = [];
  const maxWork = 10_000;
  const maxDepth = 128;
  let work = 0;

  function visit(command, origin, edges, stack) {
    if (++work > maxWork) throw new Error("npm invocation expansion limit exceeded");
    occurrences.push({ origin, command: command.location, npmEdges: edges });
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
      for (const nested of scripts[edge.script]) visit(nested, origin, nextEdges, nextStack);
    }
  }

  for (const command of workflowCommands) {
    visit(command, command.origin, [], new Set());
  }
  return occurrences;
}
