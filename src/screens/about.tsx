import type { FC } from "hono/jsx";
import { canonicalUrl } from "../seo";
import { JOIN_HREF, Leaf } from "../page-shell";

export const About: FC<{ appUrl: string }> = ({ appUrl }) => (
  <Leaf
    title="About — Together We Own"
    canonical={canonicalUrl(appUrl, "/about")}
    headingId="about-heading"
    heading="About Together We Own"
  >
    <p class="strap">Est. 1998</p>
    <p class="lead">
      An adult gaming community that spent most of its life private. Now the doors are open: turn
      up, say hello, come back.
    </p>
    <dl data-testid="about-facts" class="facts">
      <div class="card">
        <dt>Voice-first</dt>
        <dd>
          The community lives in voice. Turn up, say hello, and come back — that is the whole
          membership path.
        </dd>
      </div>
      <div class="card">
        <dt>No application, no interview</dt>
        <dd>
          You start as a Prospect. Show up a few times, play, become a Member. The ladder records
          trust and time, not grind.
        </dd>
      </div>
      <div class="card">
        <dt>From forum threads to voice rooms</dt>
        <dd>
          Founded in 1998. Forum years, then voice years — duos, trios, quads, squads. Today: doors
          open.
        </dd>
      </div>
    </dl>
    <p>
      <a class="btn" href={JOIN_HREF} data-testid="about-join">
        Join with Discord
      </a>{" "}
      <a href="/">Back to the homepage</a>
    </p>
  </Leaf>
);
