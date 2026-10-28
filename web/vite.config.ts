import adapter from "@sveltejs/adapter-cloudflare";
import { sveltekit } from "@sveltejs/kit/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

// Kit 3 takes its config here; svelte.config.js is gone. Static files are not
// Kit's: public/ is copied into the asset directory after the build
// (scripts/copy-public.mjs), outside Kit's manifest, so they keep reaching the
// Hono app through the catch-all route with its host guard and headers.
//
// csrf.trustedOrigins ['*'] turns off Kit's built-in pre-hook form check only:
// that check answers cross-origin form/text-plain/bodyless POSTs with a bare
// 403 before hooks.handle runs, so those refusals would leave without the
// hardened envelope (no CSP, no no-store, no renderer marker) and without the
// Sec-Fetch-Site fallback. The hook's isSameOriginAllowed enforces the same
// rule for every content type (mirrors Hono's sameOrigin, exact exemptions
// only, body unread), so the duplicate check only hid the hardened gate.
// Remote-function origin checks ignore trustedOrigins and stay on.
export default defineConfig({
  plugins: [tailwindcss(), sveltekit({ adapter: adapter(), csrf: { trustedOrigins: ["*"] } })],
  environments: {
    ssr: {
      build: {
        minify: true,
        rolldownOptions: {
          output: {
            // Preserve source names through linker collisions as well as minification.
            keepNames: true,
            // Compact local bindings without compression rewrites. Preserve
            // function/class names: error diagnostics use constructor.name.
            // Keep licenses and maps, and never mangle property names.
            minify: { compress: false, mangle: { keepNames: true }, codegen: true },
            comments: { annotation: false, jsdoc: false, legal: true },
            // Hono and Kit share these route families. Keep their modules
            // together on the server instead of compressing each helper chunk
            // separately. This does not change client chunking.
            codeSplitting: {
              groups: [
                // Compress shared shell markup and both header representations
                // together instead of placing each in a separate gzip stream.
                {
                  name: "site-shell",
                  test: /\/(?:src\/brand-lockup\.ts|web\/src\/lib\/(?:SiteHeader|ErrorShell)\.svelte)$/,
                },
                // Both native admin boundaries repeat the same recovery markup.
                // Co-compress them with their pure shell and URL helper on SSR.
                {
                  name: "admin-errors",
                  test: /\/web\/src\/(?:lib\/(?:AdminShell\.svelte|admin-read-retry\.ts)|routes\/admin\/(?:join-attempts\/)?\+error\.svelte)$/,
                },
                // Static content has mirrored Hono/Kit markup too. Keep it in
                // one SSR gzip stream, without changing client chunk loading.
                {
                  name: "content",
                  test: /\/(?:src\/(?:screens\/(?:about|faq|rules|privacy|join)\.tsx|(?:about|faq|rules|privacy)-content\.ts)|web\/src\/(?:lib\/ContentLeaf\.svelte|routes\/(?:about|faq|rules|privacy|join)\/\+page\.svelte))$/,
                },
                // Compress Kit's home and admin markup with the Hono renderers
                // rather than using separate gzip streams for mirrored pages.
                {
                  name: "admin",
                  test: /\/(?:src\/admin\/|web\/src\/routes\/(?:\+page\.svelte$|admin\/.*\.svelte$))/,
                },
                // Co-compress the Kit profile view with its Hono markup twin.
                {
                  name: "profiles",
                  test: /\/src\/(?:profiles\/|lib\/ProfileView\.svelte$)/,
                },
                {
                  name: "events",
                  test: /\/src\/(?:events\/|kit-(?:past-)?events(?:-html)?\.tsx?$|lib\/Event(?:Detail|Card|Missing|Gone)\.svelte$|routes\/events\/past\/\+page\.svelte$)/,
                },
              ],
            },
          },
        },
      },
    },
  },
});
