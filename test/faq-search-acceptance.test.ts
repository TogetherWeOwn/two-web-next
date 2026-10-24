// route-inventory: GET /faq, GET /faq.md
// Intentionally RED until the combined build. No implementation belongs here.
// Contract defaults: first q wins (including blank); NFC, Unicode whitespace
// trim/collapse, then 120 Unicode code points; preserve display case. Matching
// uses locale-independent lowercase and literal substring over question/answer
// separately. No accent removal, compatibility normalization or full case fold.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FAQS } from "../src/faq-content";
import app from "./app";
import { buildKitFaqBundle, FAQ_ORIGIN, loadKitFaq, type FaqGroups } from "./helpers/faq-twins";

const ORIGINAL = structuredClone(FAQS);
const FIXTURES: FaqGroups = [
  {
    section: "First topic",
    sectionId: "faq-fixture-first",
    items: [
      ["Orchid eligibility?", "First answer, with complete text and punctuation."],
      [
        "How does the second answer help?",
        "A Café rendezvous 🦊 uses [a-z].* as literal text. Shared needle.",
        { label: "Fixture guide", href: "https://example.test/guide?x=1&y=2" },
      ],
      ["Unsafe literal?", '<img src=x onerror="alert(1)"> is text, never markup.'],
    ],
  },
  {
    section: "Second topic",
    sectionId: "faq-fixture-second",
    items: [
      ["Shared needle in another topic?", "Straße stays distinct from STRASSE."],
      ["Full-width?", "ＡＢＣ stays distinct from ABC."],
    ],
  },
  { section: "Last topic", sectionId: "faq-fixture-last", items: [["Tail?", "Unrelated answer."]] },
];
const ALL = [
  "Orchid eligibility?",
  "How does the second answer help?",
  "Unsafe literal?",
  "Shared needle in another topic?",
  "Full-width?",
  "Tail?",
];
const env = new Proxy(
  { APP_URL: FAQ_ORIGIN },
  {
    get(target, key) {
      if (/^(DB|DATABASE_URL|SESSION_STORE)$/.test(String(key)))
        throw new Error(`FAQ accessed forbidden binding: ${String(key)}`);
      return Reflect.get(target, key);
    },
  },
);
const pathFor = (q: string) => `/faq?${new URLSearchParams({ q })}`;
const decode = (html: string) =>
  html
    .replace(/<[^>]*>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(?:39|x27);/g, "'")
    .replace(/&amp;/g, "&");
const questions = (html: string) =>
  [...html.matchAll(/<h3\b[^>]*>([\s\S]*?)<\/h3>/g)].map((match) => decode(match[1]!));
const statusText = (html: string) => {
  const match = html.match(/<([a-z][\w-]*)\b[^>]*\brole="status"[^>]*>([\s\S]*?)<\/\1>/i);
  expect(match, "Search must expose its query/count as an accessible status").not.toBeNull();
  return decode(match![2]!).replace(/\s+/g, " ").trim();
};

let kit: Awaited<ReturnType<typeof buildKitFaqBundle>>;
beforeAll(async () => {
  kit = await buildKitFaqBundle();
}, 60_000);
afterEach(() => {
  FAQS.splice(0, FAQS.length, ...structuredClone(ORIGINAL));
  kit?.replaceFaqs(structuredClone(ORIGINAL));
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function fixtures(groups = FIXTURES) {
  FAQS.splice(0, FAQS.length, ...structuredClone(groups));
  kit.replaceFaqs(structuredClone(groups));
}

for (const twin of ["Hono", "Kit"] as const) {
  async function request(path = "/faq") {
    if (twin === "Kit") return { ...(await loadKitFaq(kit, path)), status: 200 };
    const response = await app.request(path, {}, env);
    return { html: await response.text(), headers: response.headers, status: response.status };
  }

  describe(`${twin} FAQ keyword acceptance`, () => {
    it("CONTROL: existing full FAQ, canonical, Markdown and scripts remain public-only", async () => {
      const result = await request();
      expect(result.status).toBe(200);
      expect(questions(result.html)).toEqual(
        ORIGINAL.flatMap((group) => group.items.map(([q]) => q)),
      );
      expect(result.headers.get("cache-control")).toBe("public, max-age=3600");
      expect(result.headers.getSetCookie()).toEqual([]);
      expect(result.html).toContain(`rel="canonical" href="${FAQ_ORIGIN}/faq"`);
      expect(result.html).toContain('href="/faq.md"');
      expect(result.html).not.toMatch(/<script\b|data-island=|on(?:click|submit|input)=/i);
      expect(result.html).toContain('href="/join"');
    });

    for (const [label, raw, wanted] of [
      ["question-only", "eligibility", ["Orchid eligibility?"]],
      ["answer-only", "rendezvous", ["How does the second answer help?"]],
      [
        "multiple topics in source order",
        "shared needle",
        ["How does the second answer help?", "Shared needle in another topic?"],
      ],
      ["case-insensitive", "ORCHID ELIGIBILITY", ["Orchid eligibility?"]],
      ["canonical Unicode composition", "café", ["How does the second answer help?"]],
      ["non-ASCII case", "CAFÉ", ["How does the second answer help?"]],
      ["astral literal", "🦊", ["How does the second answer help?"]],
      ["regex punctuation is literal", "[a-z].*", ["How does the second answer help?"]],
      ["regex wildcard is not special", ".+", []],
      ["accent-sensitive", "cafe", []],
      ["no full case folding", "STRASSE", []],
      ["no compatibility normalization", "ABC", []],
      ["not a fuzzy matcher", "eligibilty", []],
      ["not a cross-question/answer match", "eligibility? First", []],
    ] as const) {
      it(`filters ${label} without copying or reordering answers`, async () => {
        fixtures();
        const result = await request(pathFor(raw));
        expect(result.status).toBe(200);
        expect(questions(result.html)).toEqual(wanted);
        expect(result.headers.getSetCookie()).toEqual([]);
      });
    }

    it("shows normalized query and answer count, omits empty groups, retains complete linked answer", async () => {
      fixtures();
      const { html } = await request(pathFor(" \t shared\n needle   "));
      expect(questions(html)).toEqual([
        "How does the second answer help?",
        "Shared needle in another topic?",
      ]);
      expect(statusText(html)).toMatch(/\b2\s+(?:matching\s+)?answers\b/i);
      expect(statusText(html)).toContain("shared needle");
      expect(html).toContain('value="shared needle"');
      expect(decode(html)).toContain(FIXTURES[0]!.items[1]![1]);
      expect(html).toContain('href="https://example.test/guide?x=1&amp;y=2"');
      expect(html).toContain("Fixture guide");
      expect(html.indexOf('id="faq-fixture-first"')).toBeLessThan(
        html.indexOf('id="faq-fixture-second"'),
      );
      expect(html).not.toContain('id="faq-fixture-last"');
    });

    for (const path of ["/faq", "/faq?q=", pathFor(" \t\n  ")]) {
      it(`returns every answer for an empty query (${encodeURI(path)})`, async () => {
        fixtures();
        expect(questions((await request(path)).html)).toEqual(ALL);
      });
    }

    it("uses the first duplicate q, not the last or a joined query", async () => {
      fixtures();
      expect(questions((await request("/faq?q=eligibility&q=rendezvous")).html)).toEqual([
        "Orchid eligibility?",
      ]);
      expect(questions((await request("/faq?q=&q=eligibility")).html)).toEqual(ALL);
      expect(questions((await request("/faq?Q=eligibility")).html)).toEqual(ALL);
    });

    it("bounds after normalization at 120 code points without splitting a surrogate pair", async () => {
      const cap = "🦊".repeat(119) + "é";
      fixtures([
        {
          section: "Boundary",
          sectionId: "faq-boundary",
          items: [
            ["At cap?", cap],
            ["Noise?", "other"],
          ],
        },
      ]);
      const { html } = await request(pathFor(`  ${"🦊".repeat(119)}éx  `));
      expect(questions(html)).toEqual(["At cap?"]);
      expect(html).toContain(`value="${cap}"`);
      expect(statusText(html)).toContain(cap);
      expect(html).not.toContain("�");
    });

    it("escapes HTML-shaped literals while still matching their text", async () => {
      fixtures();
      const raw = '<img src=x onerror="alert(1)">';
      const { html } = await request(pathFor(raw));
      expect(questions(html)).toEqual(["Unsafe literal?"]);
      expect(decode(html)).toContain(raw);
      expect(html).not.toMatch(/<img\b[^>]*\bonerror=/i);
      expect(html).not.toMatch(/<script\b|on(?:submit|input|click)=/i);
      expect(html).toContain("&lt;img");
    });

    it("offers a clear recovery and only existing truthful support guidance on no match", async () => {
      const { html } = await request(pathFor("zz-no-such-answer"));
      expect(questions(html)).toEqual([]);
      expect(statusText(html)).toMatch(/\b0\s+(?:matching\s+)?answers\b/i);
      expect(html).toMatch(/<a\b[^>]*href="\/faq"[^>]*>\s*Show all answers\s*<\/a>/i);
      expect(decode(html)).toMatch(/ask in general or DM a moderator/i);
      const links = [...html.matchAll(/<a\b[^>]*href="([^"]*)"/g)].map((m) => m[1]!);
      expect(links.filter((href) => /(?:support|ticket)/i.test(href))).toEqual([]);
      expect(questions((await request("/faq")).html)).toHaveLength(
        ORIGINAL.reduce((count, group) => count + group.items.length, 0),
      );
    });

    it("separates query responses from the shared unfiltered cache", async () => {
      fixtures();
      const first = await request();
      const filtered = await request(pathFor("eligibility"));
      const other = await request(pathFor("rendezvous"));
      const last = await request();
      expect(first.headers.get("cache-control")).toBe("public, max-age=3600");
      expect(filtered.headers.get("cache-control")).toMatch(/(?:^|,)\s*(?:private|no-store)\b/);
      expect(other.headers.get("cache-control")).toMatch(/(?:^|,)\s*(?:private|no-store)\b/);
      expect(questions(filtered.html)).toEqual(["Orchid eligibility?"]);
      expect(questions(other.html)).toEqual(["How does the second answer help?"]);
      expect(questions(last.html)).toEqual(ALL);
      expect(filtered.html).toContain(`rel="canonical" href="${FAQ_ORIGIN}/faq"`);
      expect(filtered.html).toContain('href="/faq.md"');
    });

    it("needs no session, cookie, DB, network or search-string logging for a filtered read", async () => {
      const calls: unknown[][] = [];
      for (const method of ["log", "info", "warn", "error", "debug"] as const)
        vi.spyOn(console, method).mockImplementation((...args) => {
          calls.push(args);
        });
      const fetch = vi.fn(() => {
        throw new Error("FAQ must stay offline");
      });
      vi.stubGlobal("fetch", fetch);
      const sentinel = "faq-private-query-sentinel";
      const result = await request(pathFor(sentinel));
      expect(result.status).toBe(200);
      expect(result.headers.getSetCookie()).toEqual([]);
      expect(fetch).not.toHaveBeenCalled();
      expect(JSON.stringify(calls)).not.toContain(sentinel);
      expect(result.html).not.toMatch(/<script\b|data-island=/i);
      expect(kit.csr).toBe(false);
    });

    it("retains existing answer destinations, topic links and review metadata under filtering", async () => {
      const full = await request();
      const filtered = await request(pathFor("waitlist promotions"));
      expect(questions(filtered.html)).toEqual(["How do waitlist promotions work?"]);
      expect(filtered.html).toContain('id="faq-events"');
      // Keep any neighboring stable destination on the matching card. The
      // navigation/metadata features may land independently of this slice.
      const fullCard = full.html.match(/<h3\b([^>]*)>How do waitlist promotions work\?<\/h3>/);
      const filteredCard = filtered.html.match(
        /<h3\b([^>]*)>How do waitlist promotions work\?<\/h3>/,
      );
      expect(filteredCard?.[1]).toBe(fullCard?.[1]);
      const reviewed = [...full.html.matchAll(/<time\b[^>]*>[\s\S]*?<\/time>/g)].map((m) => m[0]);
      for (const stamp of reviewed) expect(filtered.html).toContain(stamp);
      const fullIds = new Set([...full.html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
      for (const link of filtered.html.matchAll(/href="#(faq-[^"]+)"/g)) {
        expect(fullIds.has(link[1])).toBe(true);
        expect(filtered.html).toContain(`id="${link[1]}"`);
      }
    });
  });
}

it("CONTROL: /faq.md remains the complete FAQ even with a search query", async () => {
  const plain = await app.request("/faq.md", {}, env);
  const filtered = await app.request(pathFor("eligibility").replace("/faq?", "/faq.md?"), {}, env);
  const markdown = await plain.text();
  expect(filtered.status).toBe(200);
  expect(await filtered.text()).toBe(markdown);
  for (const group of ORIGINAL)
    for (const [question, answer, link] of group.items) {
      expect(markdown).toContain(question);
      expect(markdown).toContain(answer);
      if (link) expect(markdown).toContain(link.href);
    }
  expect(filtered.headers.getSetCookie()).toEqual([]);
});
