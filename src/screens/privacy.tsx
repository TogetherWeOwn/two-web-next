import type { FC } from "hono/jsx";
import { canonicalUrl } from "../seo";
import { JOIN_HREF, Leaf } from "../page-shell";

// Versioned privacy policy (N1: TOG-9893). The body is pre-rendered markdown
// HTML (see src/privacy.ts); the component only stamps the version and wraps
// it in the funnel leaf chrome. No JavaScript ships on this page.
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
      Version {version}
    </p>
    <div data-testid="privacy-policy" dangerouslySetInnerHTML={{ __html: html }} />
    <p>
      <a class="btn" href={JOIN_HREF} data-testid="privacy-join">
        Join with Discord
      </a>{" "}
      <a href="/">Back to the homepage</a>
    </p>
  </Leaf>
);
