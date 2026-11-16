import { builtinModules } from "node:module";

// Wrangler resolves bare Node builtins under nodejs_compat; esbuild alone does not.
// Keep the actual Worker dependency graph bundled and delegate builtins to workerd.
export const workerNodeBuiltins = {
  name: "worker-node-builtins",
  setup(builder) {
    const builtins = new Set(builtinModules);
    builder.onResolve({ filter: /^[^./][^:]*$/ }, (args) =>
      builtins.has(args.path) ? { path: `node:${args.path}`, external: true } : undefined,
    );
  },
};
