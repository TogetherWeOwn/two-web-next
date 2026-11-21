<script module lang="ts">
import Lifeline from "../../web/src/lib/Lifeline.svelte";
import { composeLifeline, type LifelineFacts } from "../../web/src/lib/lifeline";

const eventKey = "fixture-raid";
const time = (clock: string) => Date.parse(`2026-11-21T${clock}:00Z`);
const fact = (clock: string) => ({ eventKey, at: time(clock) });
const schedule = { eventKey, startsAt: time("20:00"), endsAt: time("21:00") };
const view = (now: string, facts: LifelineFacts) =>
  composeLifeline(schedule, { opened: fact("18:00"), ...facts }, time(now));
const viewerRsvp = fact("18:23");
const terminalSiteReminder = { ...fact("19:32"), sent: 8, unavailable: 2 };
const roomSnapshot = { observedAt: time("20:00"), fetchFailed: false, eventKeys: [eventKey] };
const cancelled = { ...fact("20:01"), reason: "The host cancelled because of severe weather." };
export const examples = {
  upcoming: view("19:00", { viewerRsvp }),
  frozen: view("20:12", { terminalSiteReminder, roomSnapshot }),
  cancelled: view("20:12", { viewerRsvp, cancelled, roomSnapshot }),
  ended: view("21:50", { terminalSiteReminder, echo: fact("21:41") }),
};
</script>

<main>
  {#each Object.entries(examples) as [state, steps] (state)}
    <div data-fixture={state}><Lifeline {steps} /></div>
  {/each}
</main>
