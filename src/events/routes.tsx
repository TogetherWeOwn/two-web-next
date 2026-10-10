// W8 public events routes + moderator JSON writes. Ports two-web routes/web.php event
// routes and EventPolicy: drafts 403 for non-moderators, cancelled 410 + noindex,
// /events.json needs a session, writes are moderator-only and enqueue the Discord
// write-back through the same seam as the admin panel (src/admin/writeback.ts).
//
// Barrel: one module per route group (calendar/collection, JSON, feeds/sitemap,
// detail, moderator writes, RSVP); shared middleware lives in routes-shared.
// Registration order below matches the original file exactly.
import { registerCalendarRoutes } from "./routes-calendar";
import { registerDetailRoutes } from "./routes-detail";
import { registerFeedRoutes } from "./routes-feeds";
import { registerJsonRoutes } from "./routes-json";
import { registerRsvpRoutes } from "./routes-rsvp";
import { registerWriteRoutes } from "./routes-writes";
import type { App, SessionReader } from "./routes-shared";

export type { SessionReader } from "./routes-shared";
export { PUBLIC_EVENT_READS_PER_MINUTE, eventJson } from "./routes-shared";
export { registerCalendarRoutes } from "./routes-calendar";
export { registerDetailRoutes } from "./routes-detail";
export { registerFeedRoutes } from "./routes-feeds";
export { registerJsonRoutes } from "./routes-json";
export { registerRsvpRoutes } from "./routes-rsvp";
export { registerWriteRoutes } from "./routes-writes";

export function registerEventRoutes(
  app: App,
  readSession: SessionReader,
  readFragmentSession: SessionReader,
): void {
  registerCalendarRoutes(app, readSession, readFragmentSession);
  registerJsonRoutes(app, readFragmentSession);
  registerFeedRoutes(app, readSession);
  registerDetailRoutes(app, readSession, readFragmentSession);
  registerWriteRoutes(app, readFragmentSession);
  registerRsvpRoutes(app, readFragmentSession);
}
