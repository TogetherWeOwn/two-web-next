// Acceptance-owned. Kills missing-as-zero, hidden optional failures, partial-success
// coupling, unqualified demand copy, unsafe/unknown outcomes and non-native drill-down.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { joinAttemptsUrl, parseJoinAttemptsQuery } from "../src/admin/table-list";
import {
  DIAGNOSTIC_OUTCOME,
  DIAGNOSTIC_STATES,
  DIAGNOSTIC_TWINS,
  compileDiagnosticsKit,
  renderDiagnostics,
} from "./helpers/admin-diagnostics-acceptance";

let kit: Awaited<ReturnType<typeof compileDiagnosticsKit>>;
beforeAll(async () => {
  kit = await compileDiagnosticsKit();
});
afterAll(() => kit?.dispose());

type Element = { attrs: string; body: string };
// A literal > inside a quoted attribute does not close the opening tag.
const elements = (html: string, tag: string): Element[] =>
  [
    ...html.matchAll(
      new RegExp(`<${tag}\\b((?:[^>"']|"[^"]*"|'[^']*')*)>([\\s\\S]*?)</${tag}>`, "g"),
    ),
  ].map((match) => ({
    attrs: match[1]!,
    body: match[2]!,
  }));
const attr = (element: Element, name: string) =>
  new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(element.attrs)?.[1];
const decode = (value: string) =>
  value.replace(
    /&(?:amp|lt|gt|quot|apos|#39|#x27);/g,
    (entity) =>
      ({
        "&amp;": "&",
        "&lt;": "<",
        "&gt;": ">",
        "&quot;": '"',
        "&apos;": "'",
        "&#39;": "'",
        "&#x27;": "'",
      })[entity]!,
  );

// Text observation only, never an HTML sanitizer or a value returned to a sink.
function text(html: string): string {
  let out = "";
  let index = 0;
  while (index < html.length) {
    if (html.startsWith("<!--", index)) {
      const end = html.indexOf("-->", index + 4);
      index = end < 0 ? html.length : end + 3;
    } else if (html[index] === "<") {
      const end = html.indexOf(">", index);
      index = end < 0 ? html.length : end + 1;
    } else {
      const end = html.indexOf("<", index);
      out += html.slice(index, end < 0 ? html.length : end);
      index = end < 0 ? html.length : end;
    }
  }
  return decode(out).replace(/\s+/g, " ").trim();
}
function widget(html: string, id: string): Element {
  // The outer Moderation section nests widget sections; match by opening tag.
  const match = new RegExp(
    `<section\\b([^>]*data-testid="${id}"[^>]*)>([\\s\\S]*?)</section>`,
  ).exec(html);
  expect(
    match,
    `${id}: optional diagnostic heading must remain on an admitted dashboard`,
  ).not.toBeNull();
  return { attrs: match![1]!, body: match![2]! };
}
const unavailable =
  /unavailable|not available|could not (?:be )?load|couldn't (?:be )?load|unable to load|did not load/i;
const thisLoad =
  /this (?:page )?(?:load|request)|(?:could not|couldn't|unable to|did not) load|right now|for this page/i;
const widgets = [
  { id: "join-funnel", heading: /Join funnel.*90 days/, empty: "join-funnel-empty" },
  {
    id: "top-zero-searches",
    heading: /Top searches with no results/,
    empty: "top-zero-searches-empty",
  },
];

for (const twin of DIAGNOSTIC_TWINS)
  describe(`${twin} optional diagnostic acceptance`, () => {
    for (const funnelState of DIAGNOSTIC_STATES)
      for (const searchState of DIAGNOSTIC_STATES) {
        const label = `funnel=${funnelState}, searches=${searchState}`;
        it(`diagnostic-state-matrix: ${label}`, () => {
          const html = renderDiagnostics(twin, kit, funnelState, searchState);
          for (const [i, spec] of widgets.entries()) {
            const state = i === 0 ? funnelState : searchState;
            const section = widget(html, spec.id);
            const headings = elements(section.body, "h2");
            expect(headings).toHaveLength(1);
            expect(text(headings[0]!.body)).toMatch(spec.heading);
            expect(attr(section, "aria-labelledby")).toBe(attr(headings[0]!, "id"));
            expect(attr(headings[0]!, "id")).toBeTruthy();
            const empty = section.body.includes(`data-testid="${spec.empty}"`);
            expect(empty, `${spec.id}: only a successful empty read gets empty success`).toBe(
              state === "empty",
            );
            if (state === "unavailable") {
              expect(text(section.body)).toMatch(unavailable);
              expect(text(section.body)).toMatch(thisLoad);
              expect(elements(section.body, "table")).toHaveLength(0);
              expect(section.body).not.toMatch(/data-testid="funnel-/);
              expect(text(section.body)).not.toMatch(
                /No (?:join attempts|missed searches)|\b0 (?:attempts|misses)\b/i,
              );
            } else {
              expect(text(section.body)).not.toMatch(unavailable);
              expect(elements(section.body, "table")).toHaveLength(state === "populated" ? 1 : 0);
              if (state === "populated") {
                const rows = elements(section.body, "tr").map((row) =>
                  elements(row.body, "td").map((cell) => text(cell.body)),
                );
                if (i === 0) {
                  expect(rows.some((row) => row[0]?.includes("added") && row[1] === "7")).toBe(
                    true,
                  );
                  expect(rows.some((row) => row[0]?.includes("denied") && row[1] === "2")).toBe(
                    true,
                  );
                } else {
                  expect(rows).toContainEqual([
                    'fixture <chess> & "cards"',
                    "4",
                    "2026-10-20T12:00:00.000Z",
                  ]);
                }
              }
            }
          }
          expect(html).not.toMatch(
            /ECONNREFUSED|42P01|57014|DATABASE_URL|DB\.connectionString|PostgresError|statement timeout/,
          );
          expect(html).not.toMatch(/<form\b|http-equiv="refresh"|data-island=|<button\b/);
        });
      }

    it.each(DIAGNOSTIC_STATES)(
      "funnel-provenance: %s explains retained recorded coverage and cache lag, not sample time",
      (state) => {
        const section = widget(renderDiagnostics(twin, kit, state, "empty"), "join-funnel");
        const copy = elements(section.body, "p")
          .map((p) => text(p.body))
          .join(" ");
        expect(copy).toMatch(/recorded/i);
        expect(copy).toMatch(/90 days/i);
        expect(copy).toMatch(/retain|retention|window/i);
        expect(copy).toMatch(/cach/i);
        expect(copy).toMatch(/60\s*(?:seconds|s)\b|one minute|a minute/i);
        expect(copy).toMatch(/lag|delay|not (?:a )?live|may be.*(?:old|behind)|up to/i);
        expect(copy).not.toMatch(
          /sampled at|last (?:updated|refreshed)\s*[:—]|as of\s+\d|2026-10-20/,
        );
        expect(elements(section.body, "time")).toHaveLength(0);
      },
    );

    it.each(DIAGNOSTIC_STATES)(
      "search-provenance: %s is a recorded planning hint, never all searches or proven demand",
      (state) => {
        const section = widget(renderDiagnostics(twin, kit, "empty", state), "top-zero-searches");
        const copy = elements(section.body, "p")
          .map((p) => text(p.body))
          .join(" ");
        expect(copy).toMatch(/recorded/i);
        expect(copy).toMatch(/planning|content[- ]plan/i);
        expect(copy).toMatch(/hint|signal/i);
        expect(copy).toMatch(/not all|only.*complete|partial|outage|may.*(?:missing|not.*record)/i);
        expect(copy).toMatch(/not.*(?:proof|demand|guarantee|promise)|(?:isn't|aren't).*demand/i);
        expect(copy).toMatch(/no.*(?:identity|searcher|IP)|not.*identify|cannot.*identify/i);
        expect(copy).not.toMatch(
          /a game night nobody posted|what guests looked for on \/events and found nothing/i,
        );
        expect(copy).not.toMatch(
          /(?:last|past|within|retained for)\s+\d+\s+days|\d+[- ]day (?:retention|window)/i,
        );
        if (state === "empty") {
          const empty = new RegExp(
            `<p\\b[^>]*data-testid="top-zero-searches-empty"[^>]*>([\\s\\S]*?)</p>`,
          ).exec(section.body);
          expect(empty).not.toBeNull();
          expect(text(empty![1]!)).toMatch(/recorded/i);
        }
      },
    );

    it.each(["added", "denied", DIAGNOSTIC_OUTCOME])(
      "native-outcome-link: %j reaches that exact recorded filter on page 1",
      (outcome) => {
        const section = widget(renderDiagnostics(twin, kit, "populated", "empty"), "join-funnel");
        const links = elements(section.body, "a").filter((link) => {
          const href = attr(link, "href");
          return (
            href &&
            new URL(decode(href), "https://example.test").searchParams.get("outcome") === outcome
          );
        });
        expect(
          links,
          "every recorded outcome, including unknown values, needs one native drill-down",
        ).toHaveLength(1);
        const link = links[0]!;
        const href = decode(attr(link, "href")!);
        const destination = new URL(href, "https://example.test");
        expect(destination.origin).toBe("https://example.test");
        expect(destination.pathname).toBe("/admin/join-attempts");
        expect(destination.hash).toBe("");
        expect(parseJoinAttemptsQuery(Object.fromEntries(destination.searchParams))).toEqual({
          outcome,
          q: "",
          page: 1,
        });
        // Hand-derived query and page, then canonicalize with the existing builder.
        expect(href).toBe(joinAttemptsUrl({ outcome, q: "", page: 1 }, 1));
        const name = decode(attr(link, "aria-label") ?? text(link.body));
        expect(name).toContain(outcome.trim());
        expect(name).toMatch(/attempt|view|show|filter/i);
        expect(attr(link, "role")).not.toBe("button");
        expect(attr(link, "tabindex")).not.toBe("-1");
        expect(attr(link, "target")).toBeUndefined();
        expect(link.attrs).not.toMatch(/\bonclick=|\bdownload(?:=|\s|$)/i);
        expect(section.body).not.toContain("<recorded>");
      },
    );

    it("table-scroll-controls: data tables retain column semantics and named keyboard regions", () => {
      const html = renderDiagnostics(twin, kit, "populated", "populated");
      for (const [i, spec] of widgets.entries()) {
        const section = widget(html, spec.id);
        const region = new RegExp(
          `<div\\b([^>]*data-testid="${spec.id}-table-scroll"[^>]*)>([\\s\\S]*?)</div>`,
        ).exec(section.body);
        expect(region).not.toBeNull();
        const wrapper = { attrs: region![1]!, body: region![2]! };
        expect(attr(wrapper, "role")).toBe("region");
        expect(attr(wrapper, "tabindex")).toBe("0");
        expect(attr(wrapper, "aria-label")).toBeTruthy();
        const hint = attr(wrapper, "aria-describedby");
        expect(hint).toBeTruthy();
        expect(
          elements(section.body, "p").some(
            (p) => attr(p, "id") === hint && /scroll/i.test(text(p.body)),
          ),
        ).toBe(true);
        const headers = elements(wrapper.body, "th");
        expect(headers.map((header) => text(header.body))).toEqual(
          i === 0 ? ["Outcome", "Attempts"] : ["Search", "Misses", "Last searched"],
        );
        expect(headers.every((header) => attr(header, "scope") === "col")).toBe(true);
      }
    });
  });

it("outcome-parser-control: URL-sensitive unknown recorded strings are neither trimmed nor coerced", () => {
  const parsed = parseJoinAttemptsQuery({ outcome: DIAGNOSTIC_OUTCOME, page: "99" });
  expect(parsed).toEqual({ outcome: DIAGNOSTIC_OUTCOME, q: "", page: 99 });
  const url = new URL(joinAttemptsUrl(parsed, 1), "https://example.test");
  expect(url.pathname).toBe("/admin/join-attempts");
  expect(url.searchParams.get("outcome")).toBe(' future/<recorded> & "quoted" +?#% ');
  expect(url.searchParams.get("page")).toBe("1");
  expect(url.hash).toBe("");
});
