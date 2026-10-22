import type { FC } from "hono/jsx";
import { aboutPageData } from "../about-content";
import type { LadderRank } from "../ladder-copy";
import { canonicalUrl } from "../seo";
import { JOIN_HREF, Leaf } from "../page-shell";

// The optional ranks slice derives the ladder fact from the bot-owned rank
// views; without it the static null-state bytes render.
export const About: FC<{ appUrl: string; ranks?: LadderRank[] }> = ({ appUrl, ranks }) => {
  const { strap, lead, facts } = aboutPageData(appUrl, ranks);
  return (
    <Leaf
      title="About — Together We Own"
      canonical={canonicalUrl(appUrl, "/about")}
      headingId="about-heading"
      heading="About Together We Own"
    >
      <p class="strap">{strap}</p>
      <p class="lead">{lead}</p>
      <dl data-testid="about-facts" class="facts">
        {facts.map(([term, definition]) => (
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
};
