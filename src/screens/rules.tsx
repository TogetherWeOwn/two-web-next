import type { FC } from "hono/jsx";
import { canonicalUrl } from "../seo";
import { JOIN_HREF, Leaf } from "../page-shell";
import { RULES, RULES_INTRO } from "../rules-content";

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
    <p class="lead">{RULES_INTRO}</p>
    {lastUpdated ? (
      <p data-testid="rules-last-updated" class="strap">
        Last updated <time datetime={lastUpdated.iso}>{lastUpdated.label}</time>
      </p>
    ) : null}
    <nav aria-label="Jump to a rule" data-testid="rules-jump">
      <p class="strap">Jump to a rule</p>
      <ul>
        {RULES.map(([name, , id]) => (
          <li key={id}>
            <a href={`#${id}`}>{name}</a>
          </li>
        ))}
      </ul>
    </nav>
    <ol data-testid="rules-list" class="facts">
      {RULES.map(([name, body, id]) => (
        <li class="card" key={id}>
          <h2 id={id}>{name}</h2>
          <p>{body}</p>
          <a class="rule-permalink" href={`#${id}`} aria-label={`Permalink to rule: ${name}`}>
            Permalink
          </a>
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
