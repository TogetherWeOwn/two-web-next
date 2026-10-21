<script lang="ts">
import Shell from "#lib/Shell.svelte";

// Shared refusal shell: the Svelte adapter over the RsvpRefusalModel shape
// (src/events/rsvp-refusal.ts). Markup contract of renderRsvpRefusal
// (src/events/rsvp-refusal-hono.tsx over EventDetailShell): the event back
// nav, the failure heading, the announced message and the return-to-event
// link keep their classes, testids and copy on every renderer, so the no-JS
// refusal contract still applies whichever renderer owns the bytes. Copy is
// duplicated here deliberately (never imported from the .tsx): importing the
// Hono screen would bundle the JSX runtime into the Kit worker. The model
// carries only display copy and the server-built return path — never a
// submitted body — so no raw-HTML rendering is needed and Svelte's default
// escaping holds.
let {
  title,
  message,
  returnPath,
}: {
  title: string;
  message: string;
  returnPath: string;
} = $props();
</script>

<Shell title={title} exactTitle="{title} — Together We Own" theme="event" activeNav="event" hideAccount>
  <nav class="event-back" aria-label="Event calendar">
    <a href="/events">← All events</a>
  </nav>
  <h1>{title}</h1>
  <p role="alert">{message}</p>
  <a href={returnPath}>Return to the event</a>
</Shell>
