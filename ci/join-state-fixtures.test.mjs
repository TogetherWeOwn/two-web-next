// Run only against the separately checked out, literal pinned target in CI.
import assert from "node:assert/strict";
import { isAbsolute } from "node:path";
import { test } from "node:test";
import { appGit, srcImport } from "./join-state-evidence-source.mjs";
import { deriveSnapshot, SCENARIOS, T0, WIDGET_URL } from "./join-state-fixtures.mjs";

const target = process.env.APP_ROOT;
const expectedSha = "60c47d13e96b254e71303f24e777932a0e506713";

test("fixtures use the pinned application's real widget health", async (t) => {
  assert.ok(target && isAbsolute(target), "APP_ROOT must be absolute");
  assert.equal(appGit(target, "rev-parse", "HEAD"), expectedSha);
  assert.equal(appGit(target, "status", "--porcelain", "--untracked-files=no"), "");
  const { createDiscordWidgetHealth } = await srcImport(target, "src/discord-widget.ts");

  for (const [state, { channels, age }] of Object.entries(SCENARIOS)) {
    await t.test(state, async () => {
      const { primed, snapshot, widgetUrl, probes } = await deriveSnapshot(
        createDiscordWidgetHealth,
        state,
      );
      assert.deepEqual(probes, age > 1_000 ? [200, 429] : [200]);
      assert.equal(primed?.fetchedAt, T0, "primed at t0");
      assert.equal(widgetUrl, WIDGET_URL);
      if (state === "expired") {
        assert.equal(snapshot, null, "snapshot drops at maximum age despite the 429 refresh");
      } else {
        assert.ok(snapshot, `${state} snapshot is servable`);
        assert.equal(snapshot.fetchedAt, T0, "429 does not reset fetchedAt");
        assert.equal(snapshot.stale === true, state.startsWith("stale"));
        assert.equal(snapshot.channels.length, channels.length);
      }
    });
  }
});
