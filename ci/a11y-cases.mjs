// Only non-document exclusions, dynamic fixtures and extra states live here.
// Ordinary static HTML GETs come automatically from app.routes, including admin pages.
const event = "01J00000000000000000000015";
const cancelled = "01J00000000000000000000016";
const draft = "01J00000000000000000000017";
const member = "100000000000000101";
const otherMember = "100000000000000102";
const skip = (reason) => ({ skip: true, reason });
export const coverage = {
  "/discord": skip("External invite redirect, not an HTML page"),
  "/join/discord": skip("OAuth redirect, never contact Discord in CI"),
  "/auth/discord": skip("OAuth redirect, never contact Discord in CI"),
  "/auth/status": skip("Bool-only JSON liveness probe, not an HTML document"),
  "/auth/recover": { cases: [{ path: "/auth/recover?next=%2Fprofile" }] },
  "/auth/discord/callback": skip("OAuth callback redirects to the audited homepage notices"),
  "/auth/discord/redirect": skip("Legacy login alias redirects to the non-document OAuth start route"),
  "/admin/events/create": skip("Legacy admin alias redirects to the audited /admin/events/new form"),
  "/admin/events/:key/edit": skip("Legacy admin alias redirects to the audited /admin/events/:key form"),
  "/admin/featured-contents": skip("Legacy admin alias redirects to the audited /admin/featured list"),
  "/admin/featured-contents/create": skip("Legacy admin alias redirects to the audited /admin/featured/new form"),
  "/admin/featured-contents/:id/edit": skip("Legacy admin alias redirects to the audited /admin/featured/:id form"),
  "/sitemap_index.xml": skip("XML sitemap"),
  "/robots.txt": skip("Plain-text robots policy"),
  "/up": skip("JSON queue health response"),
  "/events.json": skip("Session-gated JSON feed"),
  "/events.ics": skip("Calendar feed, not HTML"),
  "/events.rss": skip("RSS feed, not HTML"),
  "/events/:file{.+\\.ics}": skip("Per-event calendar download, not HTML"),
  "/": { cases: [
    { path: "/" },
    { path: "/", identity: "member" },
    { path: "/", state: "counts-unavailable", readState: "unavailable" },
    ...["joined", "already_member", "join_failed", "signin_failed"].map((notice) => ({ path: `/?n=${notice}` })),
  ] },
  "/join/callback": { cases: [{ path: "/join/callback?error=access_denied" }, { path: "/join/callback" }] },
  "/events": { cases: [
    { path: "/events" },
    { path: "/events?view=calendar" },
    { path: "/events?past=1" },
    { path: "/events?q=Friday" },
    { path: "/events?q=zz-no-matches" },
    { path: "/events", identity: "member" },
    { path: "/events", identity: "moderator" },
  ] },
  "/profile": { cases: [{ path: "/profile", identity: "member" }, { path: "/profile", identity: "member", state: "stats-unavailable", readState: "unavailable" }, { path: "/profile", identity: "member", state: "validation-error", fill: [{ label: "Timezone", value: "Not/AZone" }], click: { role: "button", name: "Save" }, waitFor: { role: "alert" } }] },
  "/members/:user": { cases: [{ path: `/members/${otherMember}`, identity: "member" }, { path: `/members/${member}`, identity: "moderator" }, { path: "/members/999999999999999999", identity: "member", status: 404 }] },
  "/e/:key": { cases: [{ path: `/e/${event}` }, { path: `/e/${cancelled}`, status: 410 }, { path: `/e/${draft}`, identity: "moderator" }, { path: "/e/invalid-key", status: 404 }] },
  "/admin/events/:key": { cases: [{ path: `/admin/events/${event}`, identity: "moderator" }, { path: "/admin/events/missing", identity: "moderator", status: 404 }] },
  "/admin/featured/:id": { cases: [{ path: "/admin/featured/1", identity: "moderator" }, { path: "/admin/featured/999", identity: "moderator", status: 404 }] },
  "/admin/events": { cases: [{ path: "/admin/events", identity: "moderator" }, { path: "/admin/events?q=zz-no-matches", identity: "moderator" }] },
  "/admin/join-attempts": { cases: [{ path: "/admin/join-attempts", identity: "moderator" }, { path: "/admin/join-attempts?q=zz-no-matches", identity: "moderator" }] },
  "/admin/join-attempts/:id": { cases: [{ path: "/admin/join-attempts/1", identity: "moderator" }, { path: "/admin/join-attempts/999999", identity: "moderator", status: 404 }] },
  "/__a11y/404": { cases: [{ path: "/__a11y/404", status: 404 }] },
  "/__a11y/429": { cases: [{ path: "/__a11y/429", status: 429 }] },
  "/__a11y/500": { cases: [{ path: "/__a11y/500", status: 500 }] },
  "/__a11y/503": { cases: [{ path: "/__a11y/503", status: 503 }] },
};
