// Fixed-clock widget inputs for the pinned application's join evidence.
// Adapted from ci/join-state-evidence.test.mjs in the evidence controller.
export const GUILD_ID = "326474832151838730";
export const T0 = 1_700_000_000_000;
export const WIDGET_URL = `https://discord.com/widget?id=${GUILD_ID}&theme=dark`;

const POPULATED = [
  { id: "1", name: "Stage Room", position: 1 },
  { id: "2", name: "Voice Lounge", position: 2 },
];

export const SCENARIOS = {
  "fresh-populated": { channels: POPULATED, age: 1_000 },
  "stale-populated": { channels: POPULATED, age: 61_000 },
  "stale-empty": { channels: [], age: 61_000 },
  expired: { channels: POPULATED, age: 180_000 },
  "fresh-empty": { channels: [], age: 1_000 },
};

export async function deriveSnapshot(createDiscordWidgetHealth, state) {
  const scenario = SCENARIOS[state];
  if (!scenario) throw new Error(`unknown join fixture state: ${state}`);
  const { channels, age } = scenario;
  let clock = T0;
  let status = 200;
  const probes = [];
  const health = createDiscordWidgetHealth({
    now: () => clock,
    fetch: async () => {
      probes.push(status);
      return status === 429
        ? new Response("{}", { status: 429 })
        : new Response(
            JSON.stringify({
              id: GUILD_ID,
              name: "Together We Own",
              instant_invite: "https://discord.gg/invite",
              presence_count: 42,
              channels,
              members: ["private-member-one", "private-member-two"].map((username, i) => ({
                id: String(i),
                username,
                status: "online",
              })),
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
    },
  });
  const work = [];
  const background = (promise) => work.push(promise);
  health.url(GUILD_ID, background);
  await Promise.all(work.splice(0));
  const primed = health.snapshot(GUILD_ID);
  clock = T0 + age;
  if (age > 1_000) {
    status = 429;
    health.url(GUILD_ID, background);
    await Promise.all(work.splice(0));
  }
  return { primed, snapshot: health.snapshot(GUILD_ID), widgetUrl: health.url(GUILD_ID), probes };
}
