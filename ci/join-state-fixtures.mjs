// Deterministic Discord widget snapshots for the baseline join evidence.
import assert from "node:assert/strict";

export const guildId = "326474832151838730";
export const inviteUrl = "https://discord.gg/invite";
export const memberNames = ["private-member-one", "private-member-two"];
export const widgetUrl = `https://discord.com/widget?id=${guildId}&theme=dark`;
export const primeTime = 1_700_000_000_000;

const populated = [
  { id: "1", name: "Stage Room", position: 1 },
  { id: "2", name: "Voice Lounge", position: 2 },
];

export const scenarios = {
  "fresh-populated": { channels: populated, age: 1_000 },
  "age61s-populated": { channels: populated, age: 61_000 },
  "age61s-empty": { channels: [], age: 61_000 },
  "age180s-populated": { channels: populated, age: 180_000 },
  "fresh-empty": { channels: [], age: 1_000 },
};

export async function deriveSnapshot(createDiscordWidgetHealth, state) {
  assert.ok(Object.hasOwn(scenarios, state), `unknown fixture ${state}`);
  const { channels, age } = scenarios[state];
  let clock = primeTime;
  let status = 200;
  const health = createDiscordWidgetHealth({
    now: () => clock,
    fetch: async () =>
      status === 429
        ? new Response("{}", { status: 429 })
        : new Response(
            JSON.stringify({
              id: guildId,
              name: "Together We Own",
              instant_invite: inviteUrl,
              presence_count: 42,
              channels,
              members: memberNames.map((username, i) => ({
                id: String(i),
                username,
                status: "online",
              })),
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
  });
  const work = [];
  const background = (promise) => work.push(promise);
  health.url(guildId, background);
  await Promise.all(work.splice(0));
  assert.equal(health.snapshot(guildId)?.fetchedAt, primeTime, "primed at t0");
  clock = primeTime + age;
  if (age > 1_000) {
    status = 429;
    health.url(guildId, background);
    await Promise.all(work.splice(0));
  }
  const snapshot = health.snapshot(guildId);
  const url = health.url(guildId);
  assert.ok(snapshot, `${state} base snapshot retained`);
  assert.equal(snapshot.fetchedAt, primeTime, "fetchedAt never reset");
  assert.equal(snapshot.stale, undefined, "base snapshot has no stale flag");
  assert.equal(snapshot.channels.length, channels.length);
  assert.equal(url, widgetUrl);
  return { snapshot, widgetUrl: url };
}
