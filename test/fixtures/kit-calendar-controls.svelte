<script lang="ts">
import CalendarControls from "../../web/src/lib/CalendarControls.svelte";

let { scenario: _scenario }: { scenario: string } = $props();
const game = "Rock & Roll";
const q = 'Tom & "Jerry" +é';
const base = {
  state: { view: "list" as const, month: "2026-03", q: "", past: false, page: 1 },
  appUrl: "https://example.test",
  games: ["Chess", game],
  gameFilter: null as string | null,
  searching: false,
  pastCount: 0,
  emptyState: null as "error" | null,
  hasVisibleResults: true,
  outOfRange: false,
};
const search = {
  ...base,
  searching: true,
  gameFilter: game,
  state: { ...base.state, q, game, past: true },
};
const _scenarios: Record<string, typeof base> = {
  default: base,
  calendar: { ...base, pastCount: 3, state: { ...base.state, view: "calendar", past: true } },
  hit: search,
  miss: { ...search, hasVisibleResults: false },
  outOfRange: { ...search, hasVisibleResults: false, outOfRange: true },
  plainSearch: {
    ...search,
    gameFilter: null,
    state: { ...search.state, game: undefined },
  } as typeof base,
  gameOnly: { ...base, gameFilter: game, state: { ...base.state, game } },
  error: { ...search, emptyState: "error" },
};
</script>

<CalendarControls {..._scenarios[_scenario]!} />
