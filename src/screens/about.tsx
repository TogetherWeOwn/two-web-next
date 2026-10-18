import type { FC } from "hono/jsx";
import { ABOUT_FACTS, ABOUT_LEAD, ABOUT_STRAP } from "../about-content";
import { canonicalUrl } from "../seo";
import { JOIN_HREF, Leaf } from "../page-shell";

export const About: FC<{ appUrl: string }> = ({ appUrl }) => (
  <Leaf
    title="About — Together We Own"
    canonical={canonicalUrl(appUrl, "/about")}
    headingId="about-heading"
    heading="About Together We Own"
  >
    <p class="strap">{ABOUT_STRAP}</p>
    <p class="lead">{ABOUT_LEAD}</p>
    <dl data-testid="about-facts" class="facts">
      {ABOUT_FACTS.map(([term, definition]) => (
        <div class="card" key={term}>
          <dt>{term}</dt>
          <dd>{definition}</dd>
        </div>
      ))}
    </dl>
    <p>
      <a class="btn" href={JOIN_HREF} data-testid="about-join">
        Join with Discord
      </a>{" "}
      <a href="/">Back to the homepage</a>
    </p>
  </Leaf>
);
