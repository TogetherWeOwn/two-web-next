import { parseSigned } from "hono/utils/cookie";
import { safeNext } from "./join/service";
import { EXPIRED_WRITE_COOKIE } from "./write-recovery";

// A browser fetch can request a full HTML page but discard its shell. Islands
// must mark those reads explicitly: Fetch Metadata also distinguishes them from
// navigations when present, but older clients may omit it. Accept is not proof.
export function isKitNoticeDocument(request: Request, isDataRequest = false): boolean {
  if (request.method !== "GET" || isDataRequest) return false;
  const headers = request.headers;
  if (headers.has("x-two-island")) return false;
  const destination = headers.get("sec-fetch-dest");
  const mode = headers.get("sec-fetch-mode");
  if (destination !== null && destination !== "document") return false;
  if (mode !== null && mode !== "navigate") return false;
  if (/prefetch/i.test(`${headers.get("purpose") ?? ""} ${headers.get("sec-purpose") ?? ""}`))
    return false;
  let path: string;
  try {
    path = decodeURIComponent(new URL(request.url).pathname);
  } catch {
    return false;
  }
  return !/^\/auth(?:\/|$)/.test(path) && !/\/__data\.json$/.test(path);
}

// Separate from the session bridge: public documents need only a signature
// check, never a session-store read. Expose a boolean, not the signed destination,
// through root layout data. Pending/tampered/unsafe values remain invisible.
export async function readKitRestoredWrite(
  request: Request,
  sessionSecret: string | undefined,
  isDataRequest = false,
): Promise<boolean> {
  if (!sessionSecret || !isKitNoticeDocument(request, isDataRequest)) return false;
  try {
    const cookies = await parseSigned(request.headers.get("cookie") ?? "", sessionSecret);
    const raw = cookies[EXPIRED_WRITE_COOKIE];
    return (
      typeof raw === "string" && raw.startsWith("restored|") && safeNext(raw.slice(9)) !== null
    );
  } catch {
    return false;
  }
}
