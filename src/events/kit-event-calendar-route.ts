import { getPath, tryDecodeURIComponent } from "hono/utils/url";

export const EVENT_CALENDAR_ROUTE = "/events/:file{.+\\.ics}";

// Keep the literal mount and suffix, and require one segment. A line break
// in the decoded segment goes to Hono's detail JSON route, where .+ fails.
const singleCalendarPath = /^\/events\/([^/\r\n\u2028\u2029]+)\.ics$/;
const legacyCalendarPath = /^\/events\/(.+)\.ics$/;

export const KIT_EVENT_CALENDAR_ROUTE = {
  method: "GET",
  path: EVENT_CALENDAR_ROUTE,
  enabled: true,
  reads: "public", // The shared handler resolves the session only for a draft.
  dynamic: {
    id: "/events/[key].ics",
    matches: (raw: string, decoded: string) =>
      singleCalendarPath.test(raw) && singleCalendarPath.test(decoded),
  },
} as const;

export function kitEventCalendarKey(request: Request): string | undefined {
  // Match Hono's router decode followed by req.param(), including %25 and
  // escaped slashes. Kit params have already passed through its own decoder.
  const key = singleCalendarPath.exec(getPath(request))?.[1];
  return key === undefined ? undefined : tryDecodeURIComponent(key);
}

export function kitLegacyEventCalendarKey(
  request: Request,
  raw: string,
  decoded: string | null,
): string | undefined {
  if (decoded !== null && KIT_EVENT_CALENDAR_ROUTE.dynamic.matches(raw, decoded)) return;
  // Use the router's decoded path before decoding :file. In particular, an
  // encoded slash cannot supply the separator after the /events mount.
  const key = legacyCalendarPath.exec(getPath(request))?.[1];
  return key === undefined ? undefined : tryDecodeURIComponent(key);
}
