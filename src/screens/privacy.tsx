import type { FC } from "hono/jsx";
import { canonicalUrl } from "../seo";
import { JOIN_HREF, Leaf } from "../page-shell";
import { PREVIOUS_PUBLISHED_POLICIES } from "../privacy-history";

// Versioned privacy policy (N1: TOG-9893). The body is pre-rendered markdown
// HTML (see src/privacy.ts); the component only stamps the version and wraps
// it in the funnel leaf chrome. No JavaScript ships on this page. The history
// list below renders from the previous-published metadata authority
// (src/privacy-history.ts): native links to immutable public snapshots, never
// bundled old bodies, and the strap keeps the current policy authoritative.
export const Privacy: FC<{ appUrl: string; version: number; html: string }> = ({
  appUrl,
  version,
  html,
}) => (
  <Leaf
    title="Privacy policy — Together We Own"
    canonical={canonicalUrl(appUrl, "/privacy")}
    headingId="privacy-heading"
    heading="Privacy policy"
  >
    <p class="strap" data-testid="privacy-version">
      Version {version}, current policy
    </p>
    <div data-testid="privacy-policy" dangerouslySetInnerHTML={{ __html: html }} />
    <h2>Previous published versions</h2>
    <p>
      Historical snapshots kept in the site&apos;s public history. These are not the current policy.
    </p>
    <ul>
      {PREVIOUS_PUBLISHED_POLICIES.map((entry) => (
        <li key={entry.id}>
          <a href={entry.href}>Version {entry.version} on GitHub (public repository)</a>
        </li>
      ))}
    </ul>
    <p>
      <a class="btn" href={JOIN_HREF} data-testid="privacy-join">
        Join with Discord
      </a>{" "}
      <a href="/">Back to the homepage</a>
    </p>
  </Leaf>
);
