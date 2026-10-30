// Shared bits for the event screens (stays put): one formatter, two shells,
// one date badge. Screen modules import from here; ./pages re-exports the screens.
import type { FC, PropsWithChildren } from "hono/jsx";
import { Layout, SiteFooter, SiteHeader } from "../pages";
import type { HeaderSession, Session } from "../env";

export { fmt } from "./date-format";

const ScheduleShell: FC<
  PropsWithChildren<{
    title: string;
    canonical: string;
    description?: string;
    robots?: string;
    member?: boolean;
    /** Signed-in viewer for the account area. Members keep the Discord
        shortcut below (and gain no board link); only non-member sessions
        reach the header, so guest renders stay byte-identical. */
    session?: Session | HeaderSession | null;
    loginReturnTo?: string | null;
    markdownAlternate?: string;
  }>
> = ({
  title,
  canonical,
  description,
  robots,
  member,
  session,
  loginReturnTo,
  markdownAlternate,
  children,
}) => (
  <Layout
    title={`${title} — Together We Own`}
    canonical={canonical}
    shareDescription={description}
    robots={robots}
    theme="schedule"
    markdownAlternate={markdownAlternate}
  >
    <SiteHeader
      active="events"
      loginReturnTo={loginReturnTo}
      session={member ? undefined : session}
    >
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
    markdownAlternate?: string;
    siteJsonLd?: string;
    backLink?: { href: string; label: string } | null;
  }>
> = ({
  title,
  canonical,
  robots,
  description,
  session,
  loginReturnTo,
  account,
  markdownAlternate,
  siteJsonLd,
  backLink,
  children,
}) => (
  <Layout
    title={`${title} — Together We Own`}
    canonical={canonical}
    shareTitle={`${title} — Together We Own`}
    shareDescription={description}
    robots={robots}
    theme="event"
    markdownAlternate={markdownAlternate}
  >
    <SiteHeader session={session} active="event" loginReturnTo={loginReturnTo} account={account} />
    <main id="main" tabindex={-1}>
      <nav class="event-back" aria-label="Event calendar">
        <a href={backLink?.href ?? "/events"}>{backLink?.label ?? "← All events"}</a>
      </nav>
      {children}
      {siteJsonLd ? (
        <script
          type="application/ld+json"
          data-testid="site-jsonld"
          dangerouslySetInnerHTML={{ __html: siteJsonLd }}
        />
      ) : null}
    </main>
    <SiteFooter />
  </Layout>
);

export { EventDetailShell, ScheduleDate, ScheduleShell };
