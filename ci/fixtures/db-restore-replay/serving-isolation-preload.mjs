import { registerHooks } from "node:module";

const driverUrl = new URL("./serving-isolation-connector.mjs", import.meta.url).href;
globalThis.fetch = () => {
  throw new Error("Traffic must stay offline");
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "postgres") return { url: driverUrl, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});
