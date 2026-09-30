import type { Context, Hono } from "hono";
import type { FC, PropsWithChildren } from "hono/jsx";
import { alertRequestError } from "./alerts";
import type { Env } from "./env";
import { Layout, SiteFooter } from "./pages";

// Branded error pages (N2 slice, TOG-9906). Ports of the four legacy two-web
// errors/*.blade.php views (TOG-5626/TOG-6788). Database-free by construction:
// no session, cookie or DB reads — the database may be exactly what is broken.
const NOINDEX = "noindex, nofollow";

const JOIN_HREF = "/auth/discord";

const ErrorShell: FC<PropsWithChildren<{ code: string; title: string; headerCta?: { href: string; label: string } }>> = ({
  code,
  title,
  headerCta = { href: JOIN_HREF, label: "Sign in with Discord" },
  children,
}) => (
  <Layout title={`${title} — Together We Own`} robots={NOINDEX}>
    <header class="bar">
      <a class="brand" href="/">TWO</a>
      <nav>
        <a class="btn" href={headerCta.href}>{headerCta.label}</a>
      </nav>
    </header>
    <main>
      <section aria-labelledby="error-heading">
        <p class="strap" aria-hidden="true">{code}</p>
        <h1 id="error-heading">{title}</h1>
        {children}
      </section>
    </main>
    <SiteFooter />
  </Layout>
);

// 404 (ports errors/404 without the event suggestions: the events listing does
// not exist in two-web-next yet, so no dead /events links — CTA + home only).
export const NotFoundPage: FC = () => (
  <ErrorShell code="404" title="We cannot find that page">
    <p class="lead">
      The link may be old or mistyped, or the page may have moved. The lobby is still open — come in and say hello.
    </p>
    <p>
      <a class="btn" href={JOIN_HREF} data-testid="error-join">Join with Discord</a>{" "}
      <a href="/" data-testid="error-home">Back to the homepage</a>
    </p>
  </ErrorShell>
);

// 500 (ports errors/500). Never echoes the failure: message and trace stay in
// the logs, never in a member's browser.
export const InternalErrorPage: FC = () => (
  <ErrorShell code="500" title="Something broke on our side">
    <p class="lead">
      It is not you. We have logged the failure and the team will take a look. Try again in a minute — the lobby is
      not going anywhere.
    </p>
    <p>
      <a class="btn" href={JOIN_HREF} data-testid="error-join">Join with Discord</a>{" "}
      <a href="/" data-testid="error-home">Back to the homepage</a>
    </p>
  </ErrorShell>
);

// 429 (ports errors/429 + App\Support\ThrottleEnvelope::render).
export const RateLimitedPage: FC = () => (
  <ErrorShell code="429" title="Slow down a little">
    <p class="lead">
      You have made a lot of requests in a short time. Wait a moment and try again — the lobby is not going anywhere.
    </p>
    <p>
      <a class="btn" href={JOIN_HREF} data-testid="error-join">Join with Discord</a>{" "}
      <a href="/" data-testid="error-home">Back to the homepage</a>
    </p>
  </ErrorShell>
);

// 503 (ports errors/503). The CTA — and the header nav — point at the Discord
// invite URL directly, never /auth/discord: during maintenance /auth may itself
// be down, so nothing on this page sends the member there.
export const MaintenancePage: FC<{ inviteUrl: string }> = ({ inviteUrl }) => (
  <ErrorShell
    code="503"
    title="We will be right back"
    headerCta={{ href: inviteUrl, label: "Open Discord" }}
  >
    <p class="lead">
      The site is down for a minute of maintenance. The Discord server never closes — come in through the invite and
      we will see you there.
    </p>
    <p>
      <a class="btn" href={inviteUrl} data-testid="error-invite" rel="noopener">Use the Discord invite instead</a>{" "}
      <a href="/" data-testid="error-retry">Try again</a>
    </p>
  </ErrorShell>
);

export function notFoundHandler(c: Context): Response | Promise<Response> {
  c.header("cache-control", "no-store, private");
  c.status(404);
  return c.html(<NotFoundPage />);
}

export function internalErrorHandler(err: unknown, c: Context): Response | Promise<Response> {
  console.error("unhandled error:", err);
  alertRequestError(err, { method: c.req.method, route: c.req.routePath || c.req.path });
  c.header("cache-control", "no-store, private");
  c.status(500);
  return c.html(<InternalErrorPage />);
}

// One 429 shape for every throttle (ports ThrottleEnvelope::render): JSON
// callers get the {reason, message, retry_after} envelope, browsers get the
// branded page — both with the Retry-After header. Default 60 s, min 1 s.
// No throttle calls it yet; W9 (TOG-9688) will wire it.
export function rateLimitExceeded(c: Context, retryAfter = 60): Response | Promise<Response> {
  const parsed = Math.floor(retryAfter);
  const n = Number.isFinite(parsed) ? Math.max(1, parsed) : 60;
  c.header("Retry-After", String(n));
  const accept = c.req.header("accept") ?? "";
  if (accept.includes("application/json")) {
    c.status(429);
    return c.json({
      reason: "rate_limited",
      message: `Too many requests. Try again in ${n} seconds.`,
      retry_after: n,
    });
  }
  c.header("cache-control", "no-store, private");
  c.status(429);
  return c.html(<RateLimitedPage />);
}

export function maintenanceHandler(inviteUrl: string): (c: Context) => Response | Promise<Response> {
  return (c) => {
    c.header("cache-control", "no-store, private");
    c.status(503);
    return c.html(<MaintenancePage inviteUrl={inviteUrl} />);
  };
}

export function registerErrorHandlers(app: Hono<{ Bindings: Env }>): void {
  app.notFound((c) => notFoundHandler(c));
  app.onError((err, c) => internalErrorHandler(err, c));
}
