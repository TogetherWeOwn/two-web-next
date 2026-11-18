import { isPromise, isProxy } from "node:util/types";

// Enumerate already-parsed commands without executing them or interpreting shell
// syntax. Each command's ordered edges carry their original source locations.
// The optional synchronous projector receives copies of plain records and arrays,
// not YAML AST nodes. Projection does not establish execution safety.
export function enumerateInvocationOccurrences(workflowCommands, scripts, project) {
  const occurrences = [];
  const maxWork = 10_000;
  const maxDepth = 128;
  let work = 0;
  // Charge repeated copies as well as distinct inputs, independently of traversal.
  let cloneBudget = 1_000_000;

  function chargeClone(units) {
    cloneBudget -= units;
    if (cloneBudget < 0) throw new Error("npm invocation projection clone limit exceeded");
  }

  function clone(value, seen = new WeakMap(), depth = 0) {
    const type = typeof value;
    chargeClone(type === "string" ? value.length + 1 : 1);
    if (
      value === null ||
      type === "undefined" ||
      type === "boolean" ||
      type === "number" ||
      type === "string"
    ) {
      return value;
    }
    if (type !== "object" || isProxy(value)) {
      throw new TypeError("npm invocation projection requires plain data");
    }
    if (seen.has(value)) return seen.get(value);
    if (depth >= maxDepth) throw new Error("npm invocation projection clone depth limit exceeded");

    const array = Array.isArray(value);
    const prototype = Object.getPrototypeOf(value);
    const expectedPrototype = array ? Array.prototype : Object.prototype;
    if (prototype !== expectedPrototype && (array || prototype !== null)) {
      throw new TypeError("npm invocation projection requires plain data");
    }
    if (array) chargeClone(value.length);
    const copy = array ? new Array(value.length) : Object.create(prototype);
    seen.set(value, copy);
    for (const key of Reflect.ownKeys(value)) {
      if (array && key === "length") continue;
      const field = Object.getOwnPropertyDescriptor(value, key);
      if (typeof key !== "string" || !field.enumerable || !Object.hasOwn(field, "value")) {
        throw new TypeError("npm invocation projection requires plain data");
      }
      chargeClone(key.length + 1);
      Object.defineProperty(copy, key, {
        value: clone(field.value, seen, depth + 1),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return copy;
  }

  function visit(command, root, edges, stack) {
    if (++work > maxWork) throw new Error("npm invocation expansion limit exceeded");
    if (project === undefined) {
      occurrences.push({ origin: root.origin, command: command.location, npmEdges: edges });
    } else {
      const source = clone(command);
      const workflow = clone(root);
      const occurrence = clone({
        origin: workflow.origin,
        command: source.location,
        npmEdges: edges,
      });
      const result = project(occurrence, source, workflow);
      if (isPromise(result)) {
        // The synchronous refusal is authoritative; drain the promise rejection.
        void result.catch(() => undefined);
        throw new TypeError("npm invocation projection must be synchronous");
      }
      if (typeof result?.then === "function") {
        throw new TypeError("npm invocation projection must be synchronous");
      }
      occurrences.push(result);
    }
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
