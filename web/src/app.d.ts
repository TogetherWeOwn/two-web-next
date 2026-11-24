import type { Env as AppEnv } from "../../src/env";
import type { KitHomePanels } from "../../src/kit-home-panels";
import type { KitLocals } from "../../src/kit-session";
import type { EventGoneModel, EventMissingModel } from "../../src/kit-event-states";
import type { RecoveryModel } from "../../src/recovery-outcome";

// adapter-cloudflare 8 passes no `platform`; bindings come from
// `import { env } from "cloudflare:workers"`, typed as Cloudflare.Env.
declare global {
  namespace Cloudflare {
    interface Env extends AppEnv {}
  }
  namespace App {
    // Populated by the read-only session bridge on Kit-owned requests only
    // Hono-owned requests skip the bridge, so every field stays
    // optional. Loaders never rotate a session; only the hook can renew a
    // released document. Auth endpoints own their session effects separately.
    interface Locals {
      session?: KitLocals["session"];
      status?: KitLocals["status"];
      returnTo?: KitLocals["returnTo"];
      joinResult?: KitLocals["joinResult"];
      expiredWrite?: KitLocals["expiredWrite"];
      homePanels?: KitHomePanels;
      // Signature-verified display bit; never the signed write destination.
      restoredWrite?: boolean;
      // Display model from the admitted Hono recovery controller, never a cookie.
      recovery?: RecoveryModel;
      // Validated request id the Kit hook merged before resolve (Hono
      // requestLog parity): response header, error pages and error.alert
      // lines carry this same value. Absent off the Kit branch.
      requestId?: string;
      runAdminForm?: () => Promise<never>;
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
