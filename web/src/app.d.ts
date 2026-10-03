import type { Env as AppEnv } from "../../src/env";

// adapter-cloudflare 8 passes no `platform`; bindings come from
// `import { env } from "cloudflare:workers"`, typed as Cloudflare.Env.
declare global {
  namespace Cloudflare {
    interface Env extends AppEnv {}
  }
  namespace App {}
}

export {};
