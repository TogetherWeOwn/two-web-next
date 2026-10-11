// Shared bits for the event screens (stays put): one formatter, two shells,
// one date badge. Screen modules import from here; ./pages re-exports the screens.
import type { FC, PropsWithChildren } from "hono/jsx";
import { Layout, SiteFooter, SiteHeader } from "../pages";
import type { Session } from "../env";

// Exported for the SvelteKit spike page (web/, TOG-12247): one formatter, one markup contract.
export const fmt = (d: Date, tz: string): string => {
  try {
    return new Intl.DateTimeFormat("en-GB", {
      dateStyle: "full",
      timeStyle: "short",
      timeZone: tz,
    }).format(d);
  } catch {
    return d.toISOString();
  }
};

const ScheduleShell: FC<
  PropsWithChildren<{
    title: string;
    canonical: string;
    description?: string;
    robots?: string;
    member?: boolean;
    loginReturnTo?: string | null;
  }>
> = ({ title, canonical, description, robots, member, loginReturnTo, children }) => (
  <Layout
    title={`${title} — Together We Own`}
    canonical={canonical}
    shareDescription={description}
    robots={robots}
    theme="schedule"
  >
    <SiteHeader active="events" loginReturnTo={loginReturnTo}>
      {member ? (
        <a class="btn" href="/discord">
          Open Discord
        </a>
      ) : undefined}
    </SiteHeader>
    <main class="events-page" id="main" tabindex={-1}>
      {children}
    </main>
    <SiteFooter />
  </Layout>
);

const ScheduleDate: FC<{ date: Date; zone: string }> = ({ date, zone }) => {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-GB", {
      day: "2-digit",
      month: "short",
      timeZone: zone,
    }).formatToParts(date);
  } catch {
    parts = new Intl.DateTimeFormat("en-GB", {
      day: "2-digit",
      month: "short",
      timeZone: "UTC",
    }).formatToParts(date);
  }
  return (
    <span class="schedule-date" aria-hidden="true">
      <span>{parts.find((p) => p.type === "month")?.value}</span>
      <strong>{parts.find((p) => p.type === "day")?.value}</strong>
    </span>
  );
};

const EventDetailShell: FC<
  PropsWithChildren<{
    title: string;
    canonical?: string;
    robots?: string;
    description?: string;
    session?: Session | null;
    loginReturnTo?: string | null;
    account?: boolean;
  }>
> = ({ title, canonical, robots, description, session, loginReturnTo, account, children }) => (
  <Layout
    title={`${title} — Together We Own`}
    canonical={canonical}
    shareTitle={`${title} — Together We Own`}
    shareDescription={description}
    robots={robots}
    theme="event"
  >
    <SiteHeader session={session} active="event" loginReturnTo={loginReturnTo} account={account} />
    <main id="main" tabindex={-1}>
      <nav class="event-back" aria-label="Event calendar">
        <a href="/events">← All events</a>
      </nav>
      {children}
    </main>
    <SiteFooter />
  </Layout>
);

export { EventDetailShell, ScheduleDate, ScheduleShell };
