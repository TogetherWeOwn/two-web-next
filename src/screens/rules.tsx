import type { FC } from "hono/jsx";
import { canonicalUrl } from "../seo";
import { JOIN_HREF, Leaf } from "../page-shell";

const RULES: Array<[string, string]> = [
  [
    "18+ only",
    "Together We Own is an adult gaming community. If you are under 18, this is not your lobby yet.",
  ],
  [
    "Respect the room",
    "No harassment, hate, or punching down. Argue about games all you like; never about people.",
  ],
  [
    "Voice-first",
    "The community lives in voice. Turn up, say hello, and come back — that is the whole membership path.",
  ],
  [
    "Play fair",
    "No cheating, exploits, or griefing. Do not spoil the game for the people you share it with.",
  ],
  [
    "Moderators have the last word",
    "If a moderator asks you to stop, stop. Appeals happen in private, not in the lobby.",
  ],
];

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
