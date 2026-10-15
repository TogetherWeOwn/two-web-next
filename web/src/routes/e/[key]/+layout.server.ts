// Server-rendered only: error pages inherit csr from the layouts above the
// failing page, not from +page.server.ts, so the layout disables hydration
// for the 410/404 error responses too — the Hono 410/404 pages carry no
// script that the CSP (script-src 'self') would block.
export const csr = false;
