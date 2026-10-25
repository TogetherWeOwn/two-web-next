// route-inventory: GET /e/:key
// Independent test-owned contract. Consume unchanged; do not merge RED alone.
// Run: npm run build --prefix web && EVENT_PRINT_BROWSER_TESTS=true npx vitest run test/event-print-summary-acceptance.test.ts
// check/node22 never install Chromium, so the a11y job runs this suite with
// its executed-count verifier; a skipped run there fails the gate.
// Chromium is mandatory (no skip-green). No DB, live service, PDF endpoint or library.
// Optional evidence: EVENT_PRINT_EVIDENCE_DIR=<artifact-directory>.
// U1.1 authorized summary + full absolute start AND end; U1.2 canonical + no clutter;
// U1.3 readable long/multipage content; U1.4 unchanged screen/access/read/network bounds;
// U1.5 explicit states + honest optional omissions. Design/screenshots/quality gates
// are Builder delivery evidence, not source-string assertions masquerading as tests.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Browser, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { JoinResult } from "../src/return-journey";
import {
  CANONICAL,
  RELATED_TITLE,
  ROSTER_NAME,
  VIEWER_ID,
  openPrintFixture,
  printRow,
  printText,
  renderPrintFixture,
  type Row,
  type Twin,
  type Viewer,
} from "./helpers/event-print-fixture";

// Browser callbacks run in Chromium, not the Worker TypeScript environment.
interface BrowserElement {
  textContent: string | null;
  tagName: string;
  scrollHeight: number;
  clientHeight: number;
  scrollWidth: number;
  clientWidth: number;
  parentElement: BrowserElement | null;
  querySelectorAll(selector: string): Iterable<BrowserElement>;
  getBoundingClientRect(): { height: number };
}
declare const document: {
  activeElement: BrowserElement | null;
  querySelector(selector: string): BrowserElement | null;
};
declare const window: typeof globalThis & { print: () => void };
declare function getComputedStyle(element: BrowserElement): {
  overflowY: string;
  backgroundColor: string;
  color: string;
};

describe.skipIf(process.env.EVENT_PRINT_BROWSER_TESTS !== "true")(
  "event print summary browser acceptance",
  () => {
    let browser: Browser;
    beforeAll(async () => {
      const { chromium } = await import("playwright");
      browser = await chromium.launch({ headless: true });
    });
    afterAll(async () => {
      await browser?.close();
    });

    const TWINS: Twin[] = ["Hono", "Kit"];
    const evidence = process.env.EVENT_PRINT_EVIDENCE_DIR;
    const CLUTTER =
      'header, footer, nav, form, button, select, a[href="#main"], a[href$=".ics"], a[href="/events"], a[href="/events/past"], [data-testid="event-attendees"], [data-testid="event-copy-link"], [data-testid="event-ics"], [data-testid="event-google-calendar"], [data-testid="event-join-pitch"]';
    const LONG_TITLE = `Overnight stories ${"with friends ".repeat(18)}終`;
    const LONG_DESCRIPTION = `${"A complete paragraph about a welcoming chess evening. ".repeat(180)}FINAL-PARAGRAPH`;

    async function capture(page: Page, name: string, pdf = false) {
      if (!evidence) return;
      mkdirSync(evidence, { recursive: true });
      await page.screenshot({ path: join(evidence, `${name}.png`), fullPage: true });
      if (pdf)
        await page.pdf({
          path: join(evidence, `${name}.pdf`),
          format: "A4",
          printBackground: true,
          displayHeaderFooter: false,
        });
    }

    async function usingPage(
      twin: Twin,
      row: Row,
      viewer: Viewer,
      run: (
        page: Page,
        data: Awaited<ReturnType<typeof openPrintFixture>>,
        reads: string[],
      ) => Promise<void>,
      width = 1280,
      js = false,
      joinResult: JoinResult | null = null,
      failGoingCountRefresh = false,
    ) {
      const fixture = await renderPrintFixture(twin, row, viewer, joinResult);
      expect(fixture.status, "U1 harness: preserve served event status").toBe(
        row.status === "cancelled" ? 410 : 200,
      );
      expect(fixture.html, "U1 harness: route/model must supply actual event HTML").toContain(
        "<main",
      );
      const opened = await openPrintFixture(browser, fixture, width, js, failGoingCountRefresh);
      try {
        await run(opened.page, opened, fixture.reads);
      } finally {
        await opened.context.close();
      }
    }

    async function visibleClutter(page: Page) {
      const visible: string[] = [];
      const nodes = page.locator(CLUTTER);
      for (let i = 0; i < (await nodes.count()); i++) {
        const node = nodes.nth(i);
        if (await node.isVisible())
          visible.push(
            (await node.innerText()).trim().slice(0, 100) ||
              (await node.getAttribute("data-testid")) ||
              "interactive chrome",
          );
      }
      return visible;
    }

    for (const twin of TWINS) {
      describe(`${twin} event print acceptance`, () => {
        for (const viewer of ["guest", "member"] as const) {
          it(`U1.1 ${viewer}: print retains title/game/venue and full overnight dates with zone`, async () => {
            const row = printRow();
            await usingPage(twin, row, viewer, async (page) => {
              await page.emulateMedia({ media: "print" });
              const text = await printText(page);
              expect.soft(text).toContain(row.title);
              expect.soft(text).toContain("Chess");
              expect.soft(text).toContain("The fixture lobby");
              expect.soft(text).toContain(row.description!);
              // Literal expectations, not the implementation's date formatter.
              expect
                .soft(text, "U1.1 start is absolute, not Today/Tomorrow")
                .toMatch(/10 Jan(?:uary)? 2030|Jan(?:uary)? 10,? 2030|2030-01-10/);
              expect
                .soft(text, "U1.1 end includes its own date, not only a clock")
                .toMatch(/11 Jan(?:uary)? 2030|Jan(?:uary)? 11,? 2030|2030-01-11/);
              expect.soft(text).toMatch(/23:30|11:30\s*p\.?m\.?/i);
              expect.soft(text).toMatch(/02:15|2:15\s*a\.?m\.?/i);
              expect.soft(text).toMatch(/UTC|GMT(?:\+00:00)?/);
              // Only pin optional sections currently owned by each renderer. The
              // missing Kit host/join/accessibility parity is explicitly elsewhere.
              if (twin === "Hono") {
                expect.soft(text).toContain("Fixture host");
                expect.soft(text).toContain("Use headphones.");
                expect
                  .soft(text, "U1.1 safe joining destination is readable on paper")
                  .toContain("https://call.example.test/open-room");
                expect.soft(text).toContain("Step-free entrance; captions available.");
              }
            });
          });

          it(`U1.2 ${viewer}: canonical URL is readable print text, with no request context`, async () => {
            await usingPage(twin, printRow(), viewer, async (page) => {
              await page.emulateMedia({ media: "print" });
              const text = await printText(page);
              expect
                .soft(text, "U1.2 canonical href/meta alone is not readable paper")
                .toContain(CANONICAL);
              expect
                .soft(text)
                .not.toMatch(
                  /fixture-context|fixture-bearer|private-fixture|__Host-two_session|[?&](?:next|token|session|returnTo)=/,
                );
            });
          });

          it(`U1.2 ${viewer}: print suppresses account/nav/RSVP/share/roster/discovery, not content`, async () => {
            await usingPage(twin, printRow(), viewer, async (page) => {
              expect(
                (await visibleClutter(page)).length,
                "CONTROL: fixture really has screen chrome",
              ).toBeGreaterThan(0);
              expect(await printText(page), "CONTROL: actual discovery data is rendered").toContain(
                RELATED_TITLE,
              );
              if (viewer === "member")
                expect(await printText(page), "CONTROL: named roster must be exercised").toContain(
                  ROSTER_NAME,
                );
              await page.emulateMedia({ media: "print" });
              expect
                .soft(await visibleClutter(page), "U1.2 visible interactive chrome on paper")
                .toEqual([]);
              const text = await printText(page);
              expect.soft(text).not.toContain(RELATED_TITLE);
              expect.soft(text).not.toContain(ROSTER_NAME);
              expect.soft(text).not.toContain("Fixture account");
              expect.soft(text).toContain("Overnight chess & stories");
            });
          });
        }

        it("U1.2 sensitive joining URLs are not printable text or active paper links", async () => {
          const row = printRow({
            join_url:
              "https://call.example.test/private-room?token=fixture-bearer&session=fixture-context",
          });
          await usingPage(twin, row, "member", async (page) => {
            await page.emulateMedia({ media: "print" });
            expect
              .soft(await printText(page))
              .not.toMatch(/fixture-bearer|fixture-context|private-room/);
            const sensitive = page.locator(
              'a[href*="fixture-bearer"],a[href*="fixture-context"],a[href*="private-room"]',
            );
            for (let i = 0; i < (await sensitive.count()); i++)
              expect
                .soft(
                  await sensitive.nth(i).isVisible(),
                  "U1.2 credential-carrying PDF hyperlink must not survive",
                )
                .toBe(false);
            expect.soft(await printText(page)).toContain(row.title);
          });
        });

        // These joining fields exist only in Hono. Do not invent a Kit surface.
        if (twin === "Hono") {
          it.each([
            [
              "session path parameter",
              "https://call.example.test/open-room;jsessionid=fixture-session",
              false,
            ],
            ["encoded private boundary", "https://call.example.test/private%2fsecret", false],
            ["CONTROL public room", "https://call.example.test/open-room", true],
          ] as const)("U1.2 joining path privacy: %s", async (_name, destination, printable) => {
            await usingPage(twin, printRow({ join_url: destination }), "member", async (page) => {
              const link = page.getByTestId("event-public-join-link");
              expect(await link.isVisible(), "CONTROL: real screen joining link").toBe(true);
              expect(await link.getAttribute("href")).toBe(destination);
              await page.emulateMedia({ media: "print" });
              const text = await printText(page);
              if (printable) expect(text).toContain(destination);
              else {
                expect
                  .soft(text, "U1.2 path credentials/private destination stay off paper")
                  .not.toContain(destination);
                expect.soft(text).not.toMatch(/fixture-session|private%2fsecret|private\/secret/i);
              }
              expect(await link.isVisible(), "no active joining link on paper").toBe(false);
              expect(text).toContain("Use headphones.");
              expect(text).toContain(printRow().title);
              await page.emulateMedia({ media: "screen" });
              expect(await link.isVisible()).toBe(true);
              expect(await link.getAttribute("href")).toBe(destination);
            });
          });

          it("U1.2 joining instructions suppress sensitive lines, retain harmless lines and preserve screen originals", async () => {
            const destination =
              "https://call.example.test/private-room?token=fixture-bearer&session=fixture-context";
            const instructions = `Open ${destination}\nUse headphones.`;
            await usingPage(
              twin,
              printRow({ join_url: destination, join_instructions: instructions }),
              "member",
              async (page) => {
                const link = page.getByTestId("event-public-join-link");
                const original = page.getByTestId("event-join-instructions");
                expect(await link.isVisible()).toBe(true);
                expect(await link.getAttribute("href")).toBe(destination);
                expect(await original.isVisible()).toBe(true);
                expect(
                  await original.textContent(),
                  "CONTROL: exact unredacted screen instructions",
                ).toBe(instructions);
                await page.emulateMedia({ media: "print" });
                const text = await printText(page);
                expect.soft(text).not.toContain(destination);
                expect
                  .soft(text, "U1.2 instructions cannot bypass the URL privacy guard")
                  .not.toMatch(/private-room|fixture-bearer|fixture-context/);
                expect
                  .soft(text, "U1.2 retain the independent harmless instruction line")
                  .toContain("Use headphones.");
                expect(await link.isVisible()).toBe(false);
                await page.emulateMedia({ media: "screen" });
                expect(await link.isVisible()).toBe(true);
                expect(await link.getAttribute("href")).toBe(destination);
                expect(await original.isVisible()).toBe(true);
                expect(await original.textContent()).toBe(instructions);
              },
            );
          });

          it.each([
            [
              "unsafe",
              "https://call.example.test/private-room?token=fixture-bearer&session=fixture-context",
              false,
            ],
            ["CONTROL safe", "https://call.example.test/open-room", true],
          ] as const)(
            "U1.2 moderator draft destination: %s",
            async (_name, destination, printable) => {
              const row = printRow({ status: "draft", join_url: destination });
              await usingPage(twin, row, "moderator", async (page) => {
                const details = page.getByTestId("event-join-details");
                expect(await details.isVisible()).toBe(true);
                expect(
                  await printText(page),
                  "CONTROL: draft displays the raw destination on screen",
                ).toContain(destination);
                await page.emulateMedia({ media: "print" });
                const text = await printText(page);
                if (printable) expect(text).toContain(destination);
                else {
                  expect
                    .soft(text, "U1.2 unsafe draft paragraph needs the screen-only guard")
                    .not.toContain(destination);
                  expect.soft(text).not.toMatch(/private-room|fixture-bearer|fixture-context/);
                }
                expect(text).toMatch(/draft/i);
                expect(text).toContain(row.title);
                expect(text).toContain("Use headphones.");
                await page.emulateMedia({ media: "screen" });
                expect(await printText(page)).toContain(destination);
              });
            },
          );
        }

        it("U1.3 retained heading, metadata and body ink has at least 4.5:1 print contrast", async () => {
          await usingPage(twin, printRow(), "guest", async (page) => {
            await page.emulateMedia({ media: "print" });
            const samples = await page.evaluate(() => {
              return [
                "h1",
                "#event-description-heading",
                ".event-meta dt",
                ".event-meta time",
                '[data-testid="event-venue"]',
                ".event-description p",
              ].map((selector) => {
                const element = document.querySelector(selector)!;
                const backgrounds: string[] = [];
                for (let node: BrowserElement | null = element; node; node = node.parentElement)
                  backgrounds.push(getComputedStyle(node).backgroundColor);
                return {
                  selector,
                  text: element.textContent?.trim(),
                  color: getComputedStyle(element).color,
                  backgrounds,
                };
              });
            });
            const rgba = (value: string) => {
              const channels = value.match(/[\d.]+/g)?.map(Number);
              expect(channels, `parse actual computed RGB color ${value}`).toBeDefined();
              expect(channels!.length).toBeGreaterThanOrEqual(3);
              return [channels![0]!, channels![1]!, channels![2]!, channels![3] ?? 1];
            };
            const composite = (front: number[], back: number[]) =>
              front
                .slice(0, 3)
                .map((channel, i) => channel * front[3]! + back[i]! * (1 - front[3]!));
            const luminance = (rgb: number[]) =>
              rgb
                .map((channel) => {
                  const c = channel / 255;
                  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
                })
                .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i]!, 0);
            expect(samples.map((sample) => sample.text)).toEqual([
              printRow().title,
              "About this event",
              "Starts",
              expect.stringMatching(/2030/),
              "The fixture lobby",
              printRow().description,
            ]);
            for (const sample of samples) {
              expect(
                await page.locator(sample.selector).first().isVisible(),
                `retained ${sample.selector}`,
              ).toBe(true);
              // Composite transparent ancestors over the browser's white paper canvas.
              const background = sample.backgrounds
                .reverse()
                .reduce((back, color) => composite(rgba(color), back), [255, 255, 255]);
              const foreground = composite(rgba(sample.color), background);
              const a = luminance(foreground);
              const b = luminance(background);
              const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
              expect
                .soft(
                  ratio,
                  `${twin} ${sample.selector}: ${sample.color} on rgb(${background.join(",")})`,
                )
                .toBeGreaterThanOrEqual(4.5);
            }
          });
        });

        it("U1.2 real join-result flash is screen-visible, print-hidden and restored", async () => {
          await usingPage(
            twin,
            printRow(),
            "member",
            async (page) => {
              const flash = page.getByTestId("join-result");
              expect(
                await flash.count(),
                "CONTROL: actual route banner, not an injected stand-in",
              ).toBe(1);
              expect(await flash.isVisible()).toBe(true);
              const copy = (await flash.innerText()).trim();
              expect(copy).toContain("You are in.");
              await page.emulateMedia({ media: "print" });
              expect
                .soft(
                  await flash.isVisible(),
                  "U1.2 join-result selector suppresses the actual flash",
                )
                .toBe(false);
              expect.soft(await printText(page)).not.toContain(copy);
              expect(await printText(page)).toContain(printRow().title);
              await page.emulateMedia({ media: "screen" });
              expect(await flash.isVisible()).toBe(true);
              expect((await flash.innerText()).trim()).toBe(copy);
            },
            1280,
            false,
            "added",
          );
        });

        it("U1.2 real failed going-count refresh retry is screen-visible, print-hidden and restored", async () => {
          await usingPage(
            twin,
            printRow(),
            "guest",
            async (page, data, reads) => {
              await page.waitForFunction(
                'document.documentElement.getAttribute("data-going-count-ready") === "1"',
              );
              expect(await page.getByTestId("event-going-count-retry").count()).toBe(0);
              await page.evaluate(
                `document.dispatchEvent(new CustomEvent("going-count-updated", {detail: {eventKey: "01ARZ3NDEKTSV4RRFFQ69G5FAV", viewerState: "going"}}))`,
              );
              const retry = page.getByTestId("event-going-count-retry");
              await retry.waitFor({ state: "visible" });
              expect(await retry.innerText()).toBe("Try again");
              expect(await page.getByTestId("event-going-count-stale").innerText()).toContain(
                "Showing the last saved count.",
              );
              expect(
                data.aggregateRefreshes,
                "CONTROL: real island issued exactly one keyed aggregate GET",
              ).toEqual(["GET /events.json?event_key=01ARZ3NDEKTSV4RRFFQ69G5FAV"]);
              const beforeRequests = [...data.requests];
              const beforeReads = [...reads];
              await page.emulateMedia({ media: "print" });
              expect
                .soft(
                  await retry.isVisible(),
                  "U1.2 retry selector suppresses the live island button",
                )
                .toBe(false);
              expect.soft(await printText(page)).not.toContain("Try again");
              expect(await printText(page)).toContain(printRow().title);
              await page.emulateMedia({ media: "screen" });
              expect(await retry.isVisible()).toBe(true);
              expect(await retry.innerText()).toBe("Try again");
              expect(data.requests, "media changes cannot retry the failed read").toEqual(
                beforeRequests,
              );
              expect(reads).toEqual(beforeReads);
              expect(data.unexpected).toEqual([]);
            },
            1280,
            true,
            null,
            true,
          );
        });

        it("U1.1 CONTROL: overnight dates follow the host zone, not the UTC calendar date", async () => {
          const row = printRow({
            startsAt: new Date("2030-01-11T04:30:00Z"),
            endsAt: new Date("2030-01-11T07:15:00Z"),
            timezone: "America/New_York",
          });
          await usingPage(twin, row, "guest", async (page) => {
            await page.emulateMedia({ media: "print" });
            const text = await printText(page);
            expect(text).toMatch(/10 Jan(?:uary)? 2030|Jan(?:uary)? 10,? 2030|2030-01-10/);
            expect(text).toMatch(/11 Jan(?:uary)? 2030|Jan(?:uary)? 11,? 2030|2030-01-11/);
            expect(text).toMatch(/23:30|11:30\s*p\.?m\.?/i);
            expect(text).toMatch(/02:15|2:15\s*a\.?m\.?/i);
            expect(text).toMatch(/GMT-05:00|UTC-0?5(?::00)?|EST|America\/New_York/);
          });
        });

        it("U1.4 CONTROL: presentation adds no route reads or guest roster disclosure", async () => {
          for (const viewer of ["guest", "member"] as const) {
            const result = await renderPrintFixture(twin, printRow(), viewer);
            expect(result.status).toBe(200);
            expect(result.reads.length).toBe(
              twin === "Hono" ? (viewer === "guest" ? 6 : 11) : viewer === "guest" ? 4 : 7,
            );
            if (viewer === "guest") expect(result.html).not.toContain(ROSTER_NAME);
            else expect(result.html).toContain(ROSTER_NAME);
          }
        });

        for (const width of [1280, 390]) {
          it(`U1.3 ${width}: long title/description flows without clipping or a dark paper background`, async () => {
            await usingPage(
              twin,
              printRow({ title: LONG_TITLE, description: LONG_DESCRIPTION }),
              "guest",
              async (page) => {
                await capture(page, `${twin}-${width}-screen-before`);
                await page.emulateMedia({ media: "print" });
                await capture(page, `${twin}-${width}-print-before`, width === 1280);
                const text = await printText(page);
                expect.soft(text).toContain(LONG_TITLE);
                expect.soft(text).toContain("FINAL-PARAGRAPH");
                const metrics = await page.evaluate(() => {
                  const main = document.querySelector("main")!;
                  const title = document.querySelector("h1")!;
                  const description = [...main.querySelectorAll("p")].find((p) =>
                    p.textContent?.includes("FINAL-PARAGRAPH"),
                  )!;
                  const inspect = (element: BrowserElement) => {
                    const style = getComputedStyle(element);
                    const box = element.getBoundingClientRect();
                    return {
                      height: box.height,
                      clipped:
                        element.scrollHeight > element.clientHeight + 2 &&
                        ["hidden", "clip", "auto", "scroll"].includes(style.overflowY),
                      horizontal: element.scrollWidth > element.clientWidth + 2,
                    };
                  };
                  const ancestors = [];
                  for (
                    let element: BrowserElement | null = description;
                    element;
                    element = element.parentElement
                  ) {
                    const style = getComputedStyle(element);
                    ancestors.push({
                      clipped: inspect(element).clipped,
                      background: style.backgroundColor,
                      color: style.color,
                    });
                  }
                  return {
                    title: inspect(title),
                    description: inspect(description),
                    ancestors,
                    main: inspect(main),
                  };
                });
                expect.soft(metrics.title.horizontal, "U1.3 title wraps").toBe(false);
                expect.soft(metrics.description.horizontal, "U1.3 description wraps").toBe(false);
                expect
                  .soft(
                    metrics.ancestors.some((item) => item.clipped),
                    "U1.3 no fixed-height clipping ancestor",
                  )
                  .toBe(false);
                expect
                  .soft(metrics.description.height, "U1.3 text actually spans multiple paper pages")
                  .toBeGreaterThan(900);
                for (const ancestor of metrics.ancestors) {
                  const rgb = ancestor.background.match(/[\d.]+/g)?.map(Number) ?? [];
                  const transparent = ancestor.background === "transparent" || rgb[3] === 0;
                  if (!transparent)
                    expect
                      .soft(
                        rgb.slice(0, 3).every((channel) => channel >= 230),
                        `U1.3 light paper, got ${ancestor.background}`,
                      )
                      .toBe(true);
                }
              },
              width,
            );
          });
        }

        it("U1.4 CONTROL: screen → print → screen is local, bounded, keyboard-usable and makes no additional reads", async () => {
          await usingPage(
            twin,
            printRow(),
            "guest",
            async (page, data, reads) => {
              expect(
                await page.evaluate("window.__printInitialCalls"),
                "U1.4 never auto-print on load",
              ).toBe(0);
              const beforeReads = [...reads];
              const beforeRequests = [...data.requests];
              const beforeText = await printText(page);
              const beforeChrome = await visibleClutter(page);
              expect(beforeChrome.length).toBeGreaterThan(0);
              await page.evaluate(() => {
                const state = { prints: 0, timeouts: 0, intervals: 0 };
                Object.assign(window, { __printAcceptance: state });
                window.print = () => {
                  state.prints++;
                };
                const timeout = window.setTimeout;
                const interval = window.setInterval;
                window.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
                  state.timeouts++;
                  return timeout(...args);
                }) as typeof setTimeout;
                window.setInterval = ((...args: Parameters<typeof setInterval>) => {
                  state.intervals++;
                  return interval(...args);
                }) as typeof setInterval;
              });
              await page.emulateMedia({ media: "print" });
              await page.emulateMedia({ media: "screen" });
              expect(await printText(page)).toBe(beforeText);
              expect(await visibleClutter(page)).toEqual(beforeChrome);
              expect(reads).toEqual(beforeReads);
              expect(data.requests).toEqual(beforeRequests);
              expect(data.unexpected, "no print service or external asset request").toEqual([]);
              expect(
                await page.evaluate(
                  () => (window as unknown as { __printAcceptance: unknown }).__printAcceptance,
                ),
              ).toEqual({ prints: 0, timeouts: 0, intervals: 0 });
              await page.keyboard.press("Tab");
              expect(await page.evaluate(() => document.activeElement?.tagName)).toBe("A");
              expect(
                await page.evaluate(() => document.activeElement?.textContent?.trim()),
              ).toBeTruthy();
            },
            1280,
            true,
          );
        });

        it("U1.4 CONTROL: draft refuses guests/members before roster disclosure; moderator can view", async () => {
          const row = printRow({ status: "draft", title: "Unpublished fixture details" });
          for (const viewer of ["guest", "member"] as const) {
            const result = await renderPrintFixture(twin, row, viewer);
            expect(result.status).toBe(403);
            expect(result.html).not.toContain(row.title);
            expect(result.html).not.toContain(ROSTER_NAME);
            if (twin === "Kit") expect(result.reads).toEqual(["db", "event"]);
            else
              expect(
                result.reads.filter(
                  (sql) =>
                    (/from "rsvps"/.test(sql) && !sql.includes("group by")) ||
                    sql.startsWith('insert into "member_data_access_logs"'),
                ),
              ).toEqual([]);
          }
          const moderator = await renderPrintFixture(twin, row, "moderator");
          expect(moderator.status).toBe(200);
          expect(moderator.html).toContain(row.title);
        });

        for (const state of ["draft", "past", "cancelled"] as const) {
          it(`U1.5 ${state}: print retains explicit state without reviving interactive actions`, async () => {
            const row = printRow({
              status: state,
              ...(state === "past"
                ? {
                    startsAt: new Date("2020-01-10T23:30:00Z"),
                    endsAt: new Date("2020-01-11T02:15:00Z"),
                  }
                : {}),
            });
            await usingPage(twin, row, state === "draft" ? "moderator" : "guest", async (page) => {
              await page.emulateMedia({ media: "print" });
              await capture(page, `${twin}-${state}-print-before`);
              const text = await printText(page);
              expect
                .soft(text, "U1.5 state label must survive")
                .toMatch(
                  state === "draft"
                    ? /draft/i
                    : state === "past"
                      ? /past|ended/i
                      : /cancelled|canceled/i,
                );
              expect.soft(text).toContain(row.title);
              expect.soft(text).not.toContain(RELATED_TITLE);
              expect.soft(text).not.toContain(ROSTER_NAME);
              expect.soft(await visibleClutter(page)).toEqual([]);
            });
          });
        }

        it("U1.5 CONTROL: absent optional content stays absent; no invented host/location/join/accessibility", async () => {
          const row = printRow({
            description: null,
            location: null,
            organizer_name: null,
            join_url: null,
            join_instructions: null,
            accessibilityNotes: null,
          });
          await usingPage(twin, row, "guest", async (page) => {
            await page.emulateMedia({ media: "print" });
            const text = await printText(page);
            expect(text).toContain(row.title);
            for (const missing of [
              "The fixture lobby",
              "Fixture host",
              "Use headphones.",
              "Step-free entrance; captions available.",
              "call.example.test/open-room",
            ])
              expect(text).not.toContain(missing);
          });
        });

        it("U1.1/U1.2 CONTROL: markup-like event text cannot become executable content or expose session identity", async () => {
          const row = printRow({
            title: '<img src=x onerror="window.print()">',
            description: "<script>window.print()</script> & readable notes",
          });
          await usingPage(twin, row, "guest", async (page) => {
            await page.emulateMedia({ media: "print" });
            expect(await printText(page)).toContain(row.title);
            expect(await printText(page)).toContain(row.description!);
            expect(
              await page
                .locator(
                  'main script:not([src]):not([type="application/ld+json"]):not([type="application/json"]), main img[onerror]',
                )
                .count(),
            ).toBe(0);
            expect(await printText(page)).not.toContain(VIEWER_ID);
          });
        });
      });
    }
  },
);
