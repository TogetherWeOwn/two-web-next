// Enumerate already-parsed commands without executing them or interpreting shell
// syntax. Each command's ordered edges carry their original source locations.
export function enumerateInvocationOccurrences(workflowCommands, scripts) {
  const occurrences = [];

  function visit(command, origin, edges, stack) {
    occurrences.push({ origin, command: command.location, npmEdges: edges });
    for (const edge of command.npmEdges) {
      if (!Object.hasOwn(scripts, edge.script)) {
        throw new Error(`Unknown npm script: ${edge.script}`);
      }
      if (stack.has(edge.script)) {
        throw new Error(`npm script cycle: ${[...stack, edge.script].join(" -> ")}`);
      }
      const nextStack = new Set(stack);
      nextStack.add(edge.script);
      const nextEdges = [...edges, { script: edge.script, location: edge.location }];
      for (const nested of scripts[edge.script]) visit(nested, origin, nextEdges, nextStack);
    }
  }

  for (const command of workflowCommands) {
    visit(command, command.origin, [], new Set());
  }
  return occurrences;
}
