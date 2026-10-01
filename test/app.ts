import rawApp from "../src/index";

export { FALLBACK_INVITE } from "../src/index";

// Opt in to the configured origin without changing Hono or the runtime app.
const request: typeof rawApp.request = (input, init, bindings, executionCtx) => {
  if (typeof input === "string" && input.startsWith("/")) {
    const appUrl = bindings && "APP_URL" in bindings ? bindings.APP_URL : undefined;
    if (!appUrl) throw new Error("Relative test app requests require bindings.APP_URL");
    input = new URL(input, appUrl).toString();
  }
  return rawApp.request(input, init, bindings, executionCtx);
};

export default { request };
