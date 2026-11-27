import { getPath, tryDecodeURIComponent } from "hono/utils/url";

export const EVENTS_MARKDOWN_PATH = "/events.md";
export const EVENT_MARKDOWN_PATH = "/e/:file{.+\\.md}";
export const EVENT_MARKDOWN_ENDPOINT_ID = "/e/[key].md";

const singleMarkdownPath = /^\/e\/([^/\r\n\u2028\u2029]+)\.md$/;
const legacyMarkdownPath = /^\/e\/(.+)\.md$/;

function matchesSingleMarkdown(raw: string, decoded: string): boolean {
  return singleMarkdownPath.test(raw) && singleMarkdownPath.test(decoded);
}

export const KIT_EVENT_MARKDOWN_ROUTES = [
  { method: "GET", path: EVENTS_MARKDOWN_PATH, enabled: true, reads: "public" },
  {
    method: "GET",
    path: EVENT_MARKDOWN_PATH,
    enabled: true,
    reads: "public",
    dynamic: {
      id: EVENT_MARKDOWN_ENDPOINT_ID,
      matches: matchesSingleMarkdown,
    },
  },
] as const;

export function kitEventMarkdownKey(request: Request): string | undefined {
  // Apply the same two decode steps as Hono's route match and req.param().
  const key = singleMarkdownPath.exec(getPath(request))?.[1];
  return key === undefined ? undefined : tryDecodeURIComponent(key);
}

export function legacyEventMarkdownKey(
  request: Request,
  raw: string,
  decoded: string | null,
): string | undefined {
  if (decoded !== null && matchesSingleMarkdown(raw, decoded)) return undefined;
  // Match the legacy constraint after Hono's tolerant path decode. Decode
  // the capture only after matching, as Hono does for req.param("file").
  const key = legacyMarkdownPath.exec(getPath(request))?.[1];
  return key === undefined ? undefined : tryDecodeURIComponent(key);
}
