import type { Env as AppEnv } from "../../src/env";
import type { KitLocals } from "../../src/kit-session";

// adapter-cloudflare 8 passes no `platform`; bindings come from
// `import { env } from "cloudflare:workers"`, typed as Cloudflare.Env.
declare global {
  namespace Cloudflare {
    interface Env extends AppEnv {}
  }
  namespace App {
    // Populated by the read-only session bridge on Kit-owned requests only
    // (TOG-22116). Hono-owned requests skip the bridge, so every field stays
    // optional. Rotation, logout and OAuth stay Hono-owned: Kit reads these
    // locals but never writes session cookies from them.
    interface Locals {
      session?: KitLocals["session"];
      status?: KitLocals["status"];
      returnTo?: KitLocals["returnTo"];
      joinResult?: KitLocals["joinResult"];
      expiredWrite?: KitLocals["expiredWrite"];
    }
  }
}

export {};
