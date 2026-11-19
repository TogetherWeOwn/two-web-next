// Only the disposable checkout uses this overlay. Match at the actual dispatch
// decision, not the loader or the global manifest, and preserve every other route.
const anchor = "  const route = decideRoute(\n    event.request,\n    deps.manifest ??\n";
const disabledEntry = /method: "GET",\s+path: "\/admin\/activity-log",\s+enabled: false,/;

export function activityLogFixtureSource(source) {
  if (source.split(anchor).length !== 2 || !disabledEntry.test(source)) {
    throw new Error("Pinned dispatcher shape changed");
  }
  return source.replace(
    anchor,
    `${anchor}      (deps.appUrl === "http://127.0.0.1:8788" &&
      event.request.method === "GET" &&
      new URL(event.request.url).origin === deps.appUrl &&
      new URL(event.request.url).pathname === "/admin/activity-log"
        ? ROUTE_MANIFEST.map((entry) =>
            entry.method === "GET" && entry.path === "/admin/activity-log"
              ? { ...entry, enabled: true }
              : entry,
          )
        : undefined) ??
`,
  );
}
