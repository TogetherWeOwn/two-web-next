import { getPath, tryDecodeURIComponent } from "hono/utils/url";

export const EVENTS_MARKDOWN_PATH = "/events.md";
export const EVENT_MARKDOWN_PATH = "/e/:file{.+\\.md}";
export const EVENT_MARKDOWN_ENDPOINT_ID = "/e/[key].md";

const singleMarkdownPath = /^\/e\/([^/\r\n\u2028\u2029]+)\.md$/;

export const KIT_EVENT_MARKDOWN_ROUTES = [
  { method: "GET", path: EVENTS_MARKDOWN_PATH, enabled: true, reads: "public" },
  {
    method: "GET",
    path: EVENT_MARKDOWN_PATH,
    enabled: true,
    reads: "public",
    dynamic: {
      id: EVENT_MARKDOWN_ENDPOINT_ID,
      matches: (raw: string, decoded: string) =>
        singleMarkdownPath.test(raw) && singleMarkdownPath.test(decoded),
    },
  },
] as const;

export function kitEventMarkdownKey(request: Request): string | undefined {
  // Apply the same two decode steps as Hono's route match and req.param().
  const key = singleMarkdownPath.exec(getPath(request))?.[1];
  return key === undefined ? undefined : tryDecodeURIComponent(key);
}
