import type { Env as AppEnv } from "../../src/env";
import type { KitLocals } from "../../src/kit-session";
import type { EventGoneModel, EventMissingModel } from "../../src/kit-event-states";

// adapter-cloudflare 8 passes no `platform`; bindings come from
// `import { env } from "cloudflare:workers"`, typed as Cloudflare.Env.
declare global {
  namespace Cloudflare {
    interface Env extends AppEnv {}
  }
  namespace App {
    // Populated by the read-only session bridge on Kit-owned requests only
    // Hono-owned requests skip the bridge, so every field stays
    // optional. Rotation, logout and OAuth stay Hono-owned: Kit reads these
    // locals but never writes session cookies from them.
    interface Locals {
      session?: KitLocals["session"];
      status?: KitLocals["status"];
      returnTo?: KitLocals["returnTo"];
      joinResult?: KitLocals["joinResult"];
      expiredWrite?: KitLocals["expiredWrite"];
      // Validated request id the Kit hook merged before resolve (Hono
      // requestLog parity): response header, error pages and error.alert
      // lines carry this same value. Absent off the Kit branch.
      requestId?: string;
    }
    // Branded detail states: the /e/:key load throws the #838 state model
    // with the served status, and the route-level error page renders it. Every
    // other error() call keeps passing a plain message, as before.
    interface Error {
      message: string;
      gone?: EventGoneModel;
      missing?: EventMissingModel;
    }
  }
}

export {};
