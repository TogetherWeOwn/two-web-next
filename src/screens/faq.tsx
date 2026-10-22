import type { FC } from "hono/jsx";
import { canonicalUrl } from "../seo";
import { JOIN_HREF, Leaf } from "../page-shell";
import { FAQS, faqPageData } from "../faq-content";
import type { LadderRank } from "../ladder-copy";

// Re-exported so existing importers (the Markdown alternate) keep working.
export { FAQS };

// The optional ranks slice derives the ladder answers from the bot-owned rank
// views; without it the static null-state bytes render.
export const Faq: FC<{ appUrl: string; ranks?: LadderRank[] }> = ({ appUrl, ranks }) => {
  const { faqs } = faqPageData(appUrl, ranks);
  return (
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
      <div data-testid="faq-list">
        {faqs.map((group) => (
          <section aria-labelledby={group.sectionId} key={group.sectionId}>
            <h2 id={group.sectionId}>{group.section}</h2>
            <div>
              {group.items.map(([q, a]) => (
                <div class="card" key={q}>
                  <h3>{q}</h3>
                  <p>{a}</p>
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
};
