import assert from "node:assert/strict";
import { test } from "node:test";
import { createDiscordWidgetHealth, toPublicWidgetSnapshot } from "../src/discord-widget.ts";
import {
  deriveSnapshot,
  memberNames,
  primeTime,
  scenarios,
  widgetUrl,
} from "./join-state-fixtures.mjs";

for (const [state, { channels, age }] of Object.entries(scenarios)) {
  test(`baseline fixture ${state} uses the expected clock and rate limit`, async () => {
    const probes = [];
    const createHealth = (deps) =>
      createDiscordWidgetHealth({
        ...deps,
        fetch: async (...args) => {
          const response = await deps.fetch(...args);
          probes.push({ time: deps.now(), status: response.status });
          return response;
        },
      });
    const fixture = await deriveSnapshot(createHealth, state);
    assert.deepEqual(probes, [
      { time: primeTime, status: 200 },
      ...(age > 1_000 ? [{ time: primeTime + age, status: 429 }] : []),
    ]);
    assert.equal(fixture.widgetUrl, widgetUrl);
    assert.equal(fixture.snapshot.fetchedAt, primeTime);
    assert.equal(fixture.snapshot.presenceCount, 42);
    assert.deepEqual(
      fixture.snapshot.channels.map(({ name }) => name),
      channels.map(({ name }) => name),
    );
    const publicSnapshot = JSON.stringify(toPublicWidgetSnapshot(fixture.snapshot));
    for (const name of memberNames) assert.ok(!publicSnapshot.includes(name));
  });
}

test("unknown fixtures fail explicitly", async () => {
  await assert.rejects(deriveSnapshot(createDiscordWidgetHealth, "missing"), /unknown fixture/);
});
