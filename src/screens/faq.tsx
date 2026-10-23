import type { FC } from "hono/jsx";
import { canonicalUrl } from "../seo";
import { JOIN_HREF, Leaf } from "../page-shell";
import { FAQS } from "../faq-content";

// Re-exported so existing importers (the Markdown alternate) keep working.
export { FAQS };

export const Faq: FC<{ appUrl: string }> = ({ appUrl }) => (
  <Leaf
    title="FAQ — Together We Own"
    canonical={canonicalUrl(appUrl, "/faq")}
    headingId="faq-heading"
    heading="Frequently asked questions"
  >
    <p class="strap">New here? Start here</p>
    <p class="lead">
      Short answers to what newcomers actually ask. If yours isn't here, ask in general or DM a
      moderator.
    </p>
    <nav aria-label="FAQ topics">
      <p>Jump to a topic</p>
      <div class="facts rank-stack">
        {FAQS.map((group) => (
          <a href={`#${group.sectionId}`} key={group.sectionId}>
            {group.section}
          </a>
        ))}
      </div>
    </nav>
    <div data-testid="faq-list">
      {FAQS.map((group) => (
        <section aria-labelledby={group.sectionId} key={group.sectionId}>
          <h2 id={group.sectionId} class="faq-target" tabindex={-1}>
            {group.section}
          </h2>
          <div>
            {group.items.map(([q, a, link, id]) => (
              <div class="card" key={id}>
                <h3 id={id} class="faq-target" tabindex={-1}>
                  {q}
                </h3>
                <p>
                  {a}
                  {link ? (
                    <>
                      {" "}
                      <a href={link.href}>{link.label}</a>
                    </>
                  ) : null}
                </p>
                <a href={`#${id}`} aria-label={`Link to this answer — ${q}`}>
                  Link to this answer
                </a>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
    <p>
      <a class="btn" href={JOIN_HREF} data-testid="faq-join">
        Join with Discord
      </a>{" "}
      <a href="/">Back to the homepage</a>
    </p>
  </Leaf>
);
