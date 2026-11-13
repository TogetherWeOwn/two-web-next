<script lang="ts">
import Button from "../../web/src/lib/Button.svelte";
let _activations = $state(0);
let _submissions = $state(0);
</script>

<form action="/submitted" onsubmit={(event) => { event.preventDefault(); _submissions += 1; }}>
<Button variant="primary" type="submit">Save event</Button>
<Button variant="primary" type="submit" disabled disabledReason="Event is full" ariaLabel="Join Raid Night" onclick={() => { _activations += 1; }}>Join event</Button>
<Button type="submit" loading loadingLabel="Saving…" onclick={() => { _activations += 1; }}>Save changes</Button>
</form>
<output data-testid="submissions">{_submissions}</output>
<output data-testid="activations">{_activations}</output>
<Button variant="saved" undoLabel="leave">Going</Button>
<Button href="/e/raid" ariaLabel="Details for Raid Night" size="sm">Details</Button>
<Button href="/events" disabled disabledReason="Event is full" ariaLabel="Reserve Raid Night">Unavailable</Button>
<Button href="/events" loading loadingLabel="Opening…">Browse</Button>
<Button variant="on-accent" size="lg" fullWidth>Continue</Button>
