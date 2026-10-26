// Test-author owned. Consume unchanged; corrections return to the acceptance author.
// Run: node --import tsx --test --test-timeout=60000 ci/timezone-suggestions-browser.test.mjs
// No opt-out: the combined implementation PR must register this command in the
// Chromium a11y job, plus TAP executed-case verification (minimum 74 cases).
// This test-only handoff intentionally does not modify CI or implement the provider.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { chromium } from "playwright";
import {
  compareResult,
  dirty,
  listState,
  noSuggestionEffects,
  openZoneControl,
  PROVIDED_ZONES,
  settle,
} from "../test/fixtures/timezone-suggestions-browser.mjs";
import { ZONE_CONTROLS, ZONE_VIEWS } from "../test/fixtures/timezone-suggestions.ts";

let browser;
before(async () => {
  browser = await chromium.launch({ headless: true });
});
after(async () => {
  await browser?.close();
});

async function withControl(view, control, options, run) {
  const fixture = await openZoneControl(browser, view, control, options);
  try {
    await run(fixture);
  } finally {
    fixture.releaseWrite();
    await fixture.context.close();
  }
}
async function offered(input) {
  const state = await listState(input);
  assert.equal(
    state.native,
    "DATALIST",
    "supported Intl must assist the existing input with a native datalist",
  );
  assert.ok(state.listId, "the input must actually reference its suggestion list");
  assert.equal(state.ids, 1, "the referenced ID resolves exactly once");
  assert.ok(state.named > 0, "the native text control retains its label");
  assert.ok(["text", "search"].includes(state.type));
  assert.equal(
    new Set(state.values).size,
    state.values.length,
    "duplicate Intl entries are not duplicate options",
  );
  return state.values;
}
async function manualAndDevice(fixture, control) {
  const { input, page } = fixture;
  await input.fill("UTC");
  await input.press("Tab");
  assert.equal(await input.inputValue(), "UTC");
  if (control === "profile") {
    assert.equal(await dirty(page), true);
    await page.getByRole("button", { name: /use this device.s time\s*zone/i }).click();
    assert.equal(await input.inputValue(), "Asia/Tokyo");
    assert.equal(
      (await fixture.profile.store.find("100000000000000001")).timezone,
      "Europe/London",
    );
  } else {
    assert.equal((await compareResult(page)).trim(), "");
    await page.getByTestId("event-chosen-timezone-button").click();
    const result = await compareResult(page);
    assert.match(result, /20:00/);
    assert.match(result, /22:00/);
    await page.getByTestId("event-device-timezone-starts-button").click();
    assert.match(
      await page.getByTestId("event-device-timezone-starts-status").textContent(),
      /05:00/,
    );
  }
  await noSuggestionEffects(fixture);
}

for (const view of ZONE_VIEWS) {
  for (const control of ZONE_CONTROLS) {
    describe(`${view} ${control} timezone suggestions`, () => {
      it("offers browser-provided identifiers on the existing labelled manual control without side effects", async () => {
        // Catches missing wiring on any twin, hardcoded lists, remote lookup, and auto-application.
        await withControl(view, control, {}, async (fixture) => {
          assert.deepEqual((await offered(fixture.input)).sort(), [...PROVIDED_ZONES].sort());
          const calls = await fixture.page.evaluate(() => window.__zoneCalls);
          assert.ok(calls.length > 0, "the browser Intl provider must be consumed");
          assert.ok(calls.every((key) => key === "timeZone"));
          assert.equal(
            await fixture.input.inputValue(),
            control === "profile" ? "Europe/London" : "",
          );
          if (control === "profile") assert.equal(await dirty(fixture.page), false);
          else assert.equal((await compareResult(fixture.page)).trim(), "");
          await noSuggestionEffects(fixture);
        });
      });

      it("deduplicates and bounds an oversized provider result", async () => {
        // 1024 is a generous acceptance safety ceiling, not a requested product limit.
        await withControl(
          view,
          control,
          { values: Array(5000).fill("Europe/Paris") },
          async (fixture) => {
            const values = await offered(fixture.input);
            assert.deepEqual(values, ["Europe/Paris"]);
            assert.ok(values.length <= 1024);
            await noSuggestionEffects(fixture);
          },
        );
      });

      it("does not turn malformed provider entries into invalid or executable suggestions", async () => {
        await withControl(
          view,
          control,
          {
            values: [
              null,
              42,
              {},
              "",
              "Not/A_Zone",
              "<img src=x onerror=alert(1)>",
              "Europe/Paris",
            ],
          },
          async (fixture) => {
            assert.deepEqual(await offered(fixture.input), ["Europe/Paris"]);
            assert.equal(await fixture.page.locator("datalist img,datalist script").count(), 0);
            await noSuggestionEffects(fixture);
          },
        );
      });

      it("rebind/rerender retains one list, one set of options and one explicit-action listener", async () => {
        await withControl(view, control, {}, async (fixture) => {
          await offered(fixture.input);
          let singleComparisonCalls;
          if (control === "event") {
            await fixture.page.evaluate(() => {
              window.__zoneFormats = 0;
              Intl.DateTimeFormat = new Proxy(Intl.DateTimeFormat, {
                apply(target, self, args) {
                  window.__zoneFormats++;
                  return Reflect.apply(target, self, args);
                },
                construct(target, args) {
                  window.__zoneFormats++;
                  return Reflect.construct(target, args);
                },
              });
            });
            await fixture.input.fill("US/Eastern");
            await fixture.page.getByTestId("event-chosen-timezone-button").click();
            singleComparisonCalls = await fixture.page.evaluate(() => window.__zoneFormats);
            assert.ok(
              singleComparisonCalls > 0,
              "instrument the real formatter, not a mock comparison",
            );
          }
          await fixture.rebind();
          await fixture.rebind();
          assert.deepEqual((await offered(fixture.input)).sort(), [...PROVIDED_ZONES].sort());
          await fixture.input.fill("US/Eastern");
          if (control === "profile") {
            await fixture.page.getByTestId("profile-save").click();
            await fixture.page.getByTestId("profile-saved").waitFor();
            assert.equal(fixture.writes.length, 1, "rebind must not duplicate the save listener");
            assert.equal(
              (await fixture.profile.store.find("100000000000000001")).timezone,
              "US/Eastern",
            );
          } else {
            await fixture.page.evaluate(() => {
              window.__zoneFormats = 0;
            });
            await fixture.page.getByTestId("event-chosen-timezone-button").click();
            assert.ok(
              (await fixture.page.evaluate(() => window.__zoneFormats)) <= singleComparisonCalls,
              "rebind must not increase comparison work; cached formatters remain allowed",
            );
            assert.match(await compareResult(fixture.page), /15:00/);
            assert.match(await compareResult(fixture.page), /17:00/);
            await noSuggestionEffects(fixture);
          }
          assert.deepEqual(fixture.errors, []);
        });
      });

      for (const scenario of [
        { name: "missing supportedValuesOf", mode: "missing" },
        { name: "throwing supportedValuesOf", mode: "throws" },
        { name: "throwing capability getter", mode: "getter-throws" },
        { name: "empty result", values: [] },
        { name: "non-array result", values: { timeZone: "Europe/Paris" } },
        { name: "unsupported native datalist UI", mode: "no-datalist" },
      ]) {
        it(`CONTROL: ${scenario.name} preserves manual entry and device shortcuts`, async () => {
          await withControl(view, control, scenario, async (fixture) => {
            if (scenario.values) assert.equal((await listState(fixture.input)).values.length, 0);
            await manualAndDevice(fixture, control);
          });
        });
      }

      it("typing an offered value and keyboard focus traversal do not save or compare", async () => {
        await withControl(view, control, {}, async (fixture) => {
          assert.ok((await offered(fixture.input)).includes("Europe/Paris"));
          await fixture.input.fill("Europe/Paris");
          await fixture.input.press("ArrowDown");
          await fixture.input.press("Escape");
          await fixture.input.press("Tab");
          assert.equal(await fixture.input.inputValue(), "Europe/Paris");
          if (control === "profile") assert.equal(await dirty(fixture.page), true);
          else assert.equal((await compareResult(fixture.page)).trim(), "");
          await noSuggestionEffects(fixture);
        });
      });

      it("CONTROL: composition keeps the user's text and does not invoke an explicit action", async () => {
        await withControl(view, control, {}, async (fixture) => {
          await fixture.input.evaluate((node) =>
            node.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })),
          );
          await fixture.input.fill("Europe/P");
          await fixture.input.evaluate((node) => {
            node.dispatchEvent(
              new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true }),
            );
            node.dispatchEvent(
              new CompositionEvent("compositionend", { data: "Europe/P", bubbles: true }),
            );
          });
          await fixture.input.press("Tab");
          assert.equal(await fixture.input.inputValue(), "Europe/P");
          if (control === "event") assert.equal((await compareResult(fixture.page)).trim(), "");
          await noSuggestionEffects(fixture);
        });
      });

      it("CONTROL: absent Intl leaves manual profile entry and the event's unsupported posture intact", async () => {
        await withControl(view, control, { mode: "missing-intl" }, async (fixture) => {
          if (control === "profile") {
            assert.equal(await fixture.input.isEditable(), true);
            await fixture.input.fill("UTC");
            assert.equal(await fixture.input.inputValue(), "UTC");
          } else {
            const compare = fixture.page.getByTestId("event-chosen-timezone-button");
            if (await compare.isEnabled()) {
              await fixture.input.fill("UTC");
              await compare.click();
            }
            const guidance = await fixture.page
              .locator("[data-event-chosen-timezone]")
              .textContent();
            assert.match(
              guidance,
              /unavailable|unable|could not|couldn't|cannot|can't|not supported/i,
            );
            assert.match(guidance, /host|shown above|calendar/i);
          }
          await noSuggestionEffects(fixture);
        });
      });

      it("CONTROL: no-JS retains the profile manual editor and the event's existing hidden enhancement", async () => {
        await withControl(view, control, { javaScriptEnabled: false }, async (fixture) => {
          if (control === "profile") {
            assert.equal(await fixture.input.isEditable(), true);
            await fixture.input.fill("US/Eastern");
            await Promise.all([
              fixture.page.waitForNavigation(),
              fixture.page.getByTestId("profile-save").click(),
            ]);
            assert.equal(
              (await fixture.profile.store.find("100000000000000001")).timezone,
              "US/Eastern",
            );
            assert.deepEqual(
              fixture.writes.map((write) => write.method),
              ["POST"],
            );
          } else {
            assert.equal(await fixture.input.isVisible(), false);
            assert.equal(
              await fixture.page.getByTestId("event-chosen-timezone-button").isVisible(),
              false,
            );
            assert.equal((await compareResult(fixture.page)).trim(), "");
            assert.equal(fixture.writes.length, 0);
          }
          assert.deepEqual(fixture.errors, []);
        });
      });
    });
  }

  describe(`${view} profile suggestion draft lifecycle`, () => {
    for (const zone of ["UTC", "US/Eastern"]) {
      it(`CONTROL: an unlisted valid ${zone} is saved verbatim only by explicit Save`, async () => {
        await withControl(view, "profile", {}, async (fixture) => {
          assert.ok(!PROVIDED_ZONES.includes(zone));
          await fixture.input.fill(zone);
          await fixture.input.press("Tab");
          assert.equal(fixture.writes.length, 0);
          assert.equal(
            (await fixture.profile.store.find("100000000000000001")).timezone,
            "Europe/London",
          );
          await fixture.page.getByTestId("profile-save").click();
          await fixture.page.getByTestId("profile-saved").waitFor();
          assert.equal(fixture.writes.length, 1);
          assert.equal((await fixture.profile.store.find("100000000000000001")).timezone, zone);
          assert.equal(await dirty(fixture.page), false);
        });
      });
    }
    for (const action of ["cancel", "reset"]) {
      it(`CONTROL: ${action} restores the saved baseline, not a suggestion or device zone`, async () => {
        await withControl(view, "profile", {}, async (fixture) => {
          await fixture.input.fill("Europe/Paris");
          assert.equal(await dirty(fixture.page), true);
          if (action === "cancel") await fixture.page.getByTestId("profile-cancel").click();
          else await fixture.input.evaluate((node) => node.form.reset());
          await settle(fixture.page);
          if (!(await fixture.input.isVisible()))
            await fixture.page.getByTestId("profile-edit").click();
          assert.equal(await fixture.input.inputValue(), "Europe/London");
          assert.equal(await dirty(fixture.page), false);
          await noSuggestionEffects(fixture);
        });
      });
    }
    it("CONTROL: client rejection retains the refused draft and other edits; correction saves once", async () => {
      await withControl(view, "profile", {}, async (fixture) => {
        await fixture.input.fill("Mars/Olympus");
        await fixture.page.locator('[name="bio"]').fill("An unsent member bio");
        await fixture.page.getByTestId("profile-save").click();
        await fixture.page.locator("#profile-timezone-error").waitFor();
        assert.equal(await fixture.input.inputValue(), "Mars/Olympus");
        assert.equal(
          await fixture.page.locator('[name="bio"]').inputValue(),
          "An unsent member bio",
        );
        assert.equal(await dirty(fixture.page), true);
        assert.equal(
          (await fixture.profile.store.find("100000000000000001")).timezone,
          "Europe/London",
        );
        await fixture.input.fill("US/Eastern");
        await fixture.page.getByTestId("profile-save").click();
        await fixture.page.getByTestId("profile-saved").waitFor();
        assert.equal(fixture.writes.length, 1);
        assert.equal(
          (await fixture.profile.store.find("100000000000000001")).timezone,
          "US/Eastern",
        );
      });
    });
    it("native 422 retains its draft when suggestions bind; a corrected unlisted alias still saves", async () => {
      // Kit's native mutations intentionally remain Hono-owned. Start from each
      // twin, exercise that real POST owner, then load the real refusal HTML.
      await withControl(
        view,
        "profile",
        { withholdProfileIslandUntilWrite: true },
        async (fixture) => {
          await fixture.input.fill("Mars/Olympus");
          await fixture.page.locator('[name="bio"]').fill("An unsent member bio");
          const [response] = await Promise.all([
            fixture.page.waitForNavigation(),
            fixture.page.getByTestId("profile-save").click(),
          ]);
          assert.equal(response.status(), 422);
          assert.ok(
            fixture.responses.some((entry) => entry.method === "POST" && entry.status === 422),
          );
          await settle(fixture.page);
          assert.equal(await fixture.input.inputValue(), "Mars/Olympus");
          assert.equal(
            await fixture.page.locator('[name="bio"]').inputValue(),
            "An unsent member bio",
          );
          assert.equal(
            (await fixture.profile.store.find("100000000000000001")).timezone,
            "Europe/London",
          );
          assert.ok((await offered(fixture.input)).includes("Europe/Paris"));
          assert.equal(
            fixture.writes.length,
            1,
            "binding suggestions must not retry a refused write",
          );
          await noSuggestionEffects(fixture, 1);
          await fixture.input.fill("US/Eastern");
          await fixture.page.getByTestId("profile-save").click();
          await fixture.page.getByTestId("profile-saved").waitFor();
          assert.equal(fixture.writes.length, 2);
          assert.equal(
            (await fixture.profile.store.find("100000000000000001")).timezone,
            "US/Eastern",
          );
        },
      );
    });

    it("CONTROL: an in-flight save cannot adopt a newer suggestion draft as its baseline", async () => {
      await withControl(view, "profile", { deferWrite: true }, async (fixture) => {
        await fixture.input.fill("US/Eastern");
        await fixture.page.getByTestId("profile-save").click();
        await fixture.receivedWrite;
        await fixture.input.fill("Europe/Paris");
        assert.equal(fixture.writes.length, 1);
        fixture.releaseWrite();
        await fixture.page.getByTestId("profile-saved").waitFor();
        assert.equal(await fixture.input.inputValue(), "Europe/Paris");
        assert.equal(
          (await fixture.profile.store.find("100000000000000001")).timezone,
          "US/Eastern",
        );
        assert.equal(await dirty(fixture.page), true);
      });
    });
  });

  describe(`${view} event suggestion explicit action`, () => {
    for (const zone of ["UTC", "US/Eastern"]) {
      it(`CONTROL: manual ${zone} compares only on activation and does not rewrite event/calendar data`, async () => {
        await withControl(view, "event", {}, async (fixture) => {
          const invariant = () =>
            fixture.page.evaluate(() => ({
              times: [...document.querySelectorAll("time[datetime]")].map((node) => node.outerHTML),
              links: [
                ...document.querySelectorAll(
                  'a[data-testid="event-ics"],a[data-testid="event-google-calendar"]',
                ),
              ].map((node) => node.outerHTML),
              schema: [...document.querySelectorAll('script[type="application/ld+json"]')].map(
                (node) => node.textContent,
              ),
            }));
          const before = await invariant();
          await fixture.input.fill(zone);
          await fixture.input.press("Tab");
          assert.equal((await compareResult(fixture.page)).trim(), "");
          await fixture.page.getByTestId("event-chosen-timezone-button").focus();
          await fixture.page.keyboard.press("Enter");
          const result = await compareResult(fixture.page);
          assert.match(result, zone === "UTC" ? /20:00/ : /15:00/);
          assert.match(result, zone === "UTC" ? /22:00/ : /17:00/);
          assert.equal(await fixture.input.inputValue(), zone);
          assert.deepEqual(await invariant(), before);
          await noSuggestionEffects(fixture);
        });
      });
    }
  });
}
