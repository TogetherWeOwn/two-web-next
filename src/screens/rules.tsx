import type { FC } from "hono/jsx";
import { canonicalUrl } from "../seo";
import { JOIN_HREF, Leaf } from "../page-shell";
import { RULES } from "../rules-content";

// Re-exported so existing importers (the Markdown alternate) keep working.
export { RULES };

// The stamp carries both the machine date and the human label (ports the
// legacy "1 September 2026" render): crawlers read datetime, members read words.
export const Rules: FC<{ appUrl: string; lastUpdated: { iso: string; label: string } | null }> = ({
  appUrl,
  lastUpdated,
}) => (
  <Leaf
    title="House rules — Together We Own"
    canonical={canonicalUrl(appUrl, "/rules")}
    headingId="rules-heading"
    heading="House rules"
  >
    <p class="lead">
      Five rules that keep the lobby a place people come back to. Short on purpose — if anything is
      unclear, ask in Discord before you assume.
    </p>
    {lastUpdated ? (
      <p data-testid="rules-last-updated" class="strap">
        Last updated <time datetime={lastUpdated.iso}>{lastUpdated.label}</time>
      </p>
    ) : null}
    <ol data-testid="rules-list" class="facts">
      {RULES.map(([name, body]) => (
        <li class="card" key={name}>
          <h2>{name}</h2>
          <p>{body}</p>
        </li>
      ))}
    </ol>
    <p>
      <a class="btn" href={JOIN_HREF} data-testid="rules-join">
        Join with Discord
      </a>{" "}
      <a href="/">Back to the homepage</a>
    </p>
  </Leaf>
);
