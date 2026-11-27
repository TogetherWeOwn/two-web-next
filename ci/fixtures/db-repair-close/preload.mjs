import { registerHooks } from "node:module";

const fixture = new URL("postgres.mjs", import.meta.url).href;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "postgres") return { shortCircuit: true, url: fixture };
    return next(specifier, context);
  },
});
