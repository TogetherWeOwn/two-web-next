import adapter from "@sveltejs/adapter-cloudflare";
import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";

// Kit 3 takes its config here; svelte.config.js is gone. Static files are not
// Kit's: public/ is copied into the asset directory after the build
// (scripts/copy-public.mjs), outside Kit's manifest, so they keep reaching the
// Hono app through the catch-all route with its host guard and headers.
export default defineConfig({
  plugins: [sveltekit({ adapter: adapter() })],
});
