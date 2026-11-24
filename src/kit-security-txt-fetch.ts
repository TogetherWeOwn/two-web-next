import type { Env } from "./env";
import { buildSecurityTxt } from "./security-txt";

// Detached response for the literal endpoint. The caller owns host admission,
// alias fallback and global response headers.
export function fetchKitSecurityTxt(request: Request, env: Pick<Env, "APP_URL">): Response | null {
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  if (new URL(request.url).pathname !== "/.well-known/security.txt") return null;

  return new Response(request.method === "HEAD" ? null : buildSecurityTxt(env.APP_URL), {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, max-age=3600",
    },
  });
}
