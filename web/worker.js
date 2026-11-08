import adapter from "./.svelte-kit/cloudflare/_worker.js";
import { protectKitWorkerResponse } from "../src/kit-worker-response.ts";

// Production's outermost response boundary. Kit's fatal error renderer and
// post-hook response rewrites run outside hooks.handle, so protect the final
// adapter response without replaying the request or changing the adapter build.
export default {
  /**
   * @param {Request} request
   * @param {Cloudflare.Env} env
   */
  async fetch(request, env) {
    return protectKitWorkerResponse(request, await adapter.fetch(request, env), env);
  },
};
