<script lang="ts">
import AdminShell from "#lib/AdminShell.svelte";
import { eventValidationSummary } from "../../../../../../src/admin/form-errors";
import type { PageProps } from "./$types";

// Markup contract of EventFormPage mode="new"
// (src/admin/pages/event-form-page.tsx + event-form-fields.tsx): the
// validation notice, field ids/names, recurrence fieldset, save/cancel
// actions, dirty-draft marker and the two progressive islands are shared, so
// the existing admin create E2E selectors still apply when this route owns
// traffic. Values and field errors arrive from the load exactly as the Hono
// 422 page echoes them (retained input, per-field messages). No island and
// no event handlers of its own: the form posts to the Hono-owned
// POST /admin/events, so the page works with JavaScript disabled, exactly
// like the Hono panel. The text-limit and editor islands enhance it when
// JavaScript runs.
let { data }: PageProps = $props();
const values = $derived(data.values ?? {});
const errors = $derived(data.errors ?? {});
const hasErrors = $derived(data.hasErrors ?? Object.keys(errors).length > 0);
const val = (name: string) => values[name] ?? "";
const timezoneVal = $derived(val("timezone") || "Europe/London");
// A component-level <script> is Svelte's own; the island tags ride {@html}.
const textLimitsIsland =
  '<script type="module" src="/islands/admin-event-text-limits.js"></' + "script>";
const editorIsland = '<script src="/islands/admin-event-editor.js" defer></' + "script>";
</script>

{#snippet fieldError(name: string, id: string)}
  {#if errors[name]}
    <p {id} class="error" role="alert" data-testid={`error-${name}`}>{errors[name]}</p>
  {/if}
{/snippet}

<AdminShell restoredWrite={data.restoredWrite} title="New event">
<section>
  <h1>New event</h1>
  {#if hasErrors}
    <div class="notice" role="alert" tabindex="-1" data-testid="form-errors" data-admin-validation-summary="">
      <p>Check the highlighted fields and try again.</p>
      <ul>
        {#each eventValidationSummary(errors, "new") as entry (entry.key)}
          <li>
            {#if entry.target}
              <a href={`#${entry.target}`}>{entry.label}: {entry.message}</a>
            {:else}
              {entry.message}
            {/if}
          </li>
        {/each}
      </ul>
    </div>
  {/if}
  <form
    method="post"
    action="/admin/events"
    data-event-editor=""
    data-event-draft={hasErrors ? "" : undefined}
  >
    <div class="field">
      <label for="f-title">Title</label>
      <input
        id="f-title"
        name="title"
        type="text"
        value={val("title")}
        data-event-text-limit={100}
        required
        aria-invalid={errors.title ? "true" : undefined}
        aria-describedby={errors.title ? "f-title-error" : undefined}
      />
      {@render fieldError("title", "f-title-error")}
    </div>
    <div class="field">
      <label for="f-game">Game</label>
      <input
        id="f-game"
        name="game"
        type="text"
        value={val("game")}
        data-event-text-limit={100}
        aria-invalid={errors.game ? "true" : undefined}
        aria-describedby={errors.game ? "f-game-error" : undefined}
      />
      {@render fieldError("game", "f-game-error")}
    </div>
    <div class="field">
      <label for="f-description">Description</label>
      <textarea
        id="f-description"
        name="description"
        rows={4}
        data-event-text-limit={1000}
        aria-invalid={errors.description ? "true" : undefined}
        aria-describedby={errors.description ? "f-description-error" : undefined}
      >{val("description")}</textarea>
      {@render fieldError("description", "f-description-error")}
    </div>
    <div class="field">
      <label for="f-starts-at">Starts (local wall time, YYYY-MM-DD HH:mm)</label>
      <input
        id="f-starts-at"
        name="starts_at"
        type="text"
        value={val("starts_at")}
        required
        aria-invalid={errors.starts_at ? "true" : undefined}
        aria-describedby={errors.starts_at ? "f-starts-at-error" : undefined}
      />
      {@render fieldError("starts_at", "f-starts-at-error")}
    </div>
    <div class="field">
      <label for="f-ends-at">Ends (local wall time, YYYY-MM-DD HH:mm)</label>
      <input
        id="f-ends-at"
        name="ends_at"
        type="text"
        value={val("ends_at")}
        required
        aria-invalid={errors.ends_at ? "true" : undefined}
        aria-describedby={errors.ends_at ? "f-ends-at-error" : undefined}
      />
      {@render fieldError("ends_at", "f-ends-at-error")}
    </div>
    <div class="field">
      <label for="f-timezone">Timezone</label>
      <input
        id="f-timezone"
        name="timezone"
        type="text"
        value={timezoneVal}
        aria-invalid={errors.timezone ? "true" : undefined}
        aria-describedby={errors.timezone ? "f-timezone-hint f-timezone-error" : "f-timezone-hint"}
      />
      <p id="f-timezone-hint" class="hint">
        The IANA zone the wall time above is typed in. Storage is UTC.
      </p>
      {@render fieldError("timezone", "f-timezone-error")}
    </div>
    <div class="field">
      <label for="f-location">Location</label>
      <input
        id="f-location"
        name="location"
        type="text"
        value={val("location")}
        data-event-text-limit={255}
        aria-invalid={errors.location ? "true" : undefined}
        aria-describedby={errors.location ? "f-location-error" : undefined}
      />
      {@render fieldError("location", "f-location-error")}
    </div>
    <div class="field">
      <label for="f-capacity">Capacity (empty = unlimited)</label>
      <input
        id="f-capacity"
        name="capacity"
        type="text"
        inputmode="numeric"
        value={val("capacity")}
        aria-invalid={errors.capacity ? "true" : undefined}
        aria-describedby={errors.capacity ? "f-capacity-error" : undefined}
      />
      {@render fieldError("capacity", "f-capacity-error")}
    </div>
    <fieldset>
      <legend>Repeat</legend>
      <div class="field">
        <label for="f-recurrence-frequency">Repeats</label>
        <select
          id="f-recurrence-frequency"
          name="recurrence_frequency"
          aria-invalid={errors.recurrence_frequency ? "true" : undefined}
          aria-describedby={errors.recurrence_frequency
            ? "f-recurrence-frequency-hint f-recurrence-frequency-error"
            : "f-recurrence-frequency-hint"}
        >
          <option value="" selected={val("recurrence_frequency") === ""}>Does not repeat</option>
          <option value="weekly" selected={val("recurrence_frequency") === "weekly"}>Weekly</option>
        </select>
        <p id="f-recurrence-frequency-hint" class="hint">
          Empty = a one-off event. Weeks keep the same wall time in the zone above across clock
          changes.
        </p>
        {@render fieldError("recurrence_frequency", "f-recurrence-frequency-error")}
      </div>
      <div class="field">
        <label for="f-recurrence-count">Occurrences (including the first, max 52)</label>
        <input
          id="f-recurrence-count"
          name="recurrence_count"
          type="text"
          inputmode="numeric"
          value={val("recurrence_count")}
          aria-invalid={errors.recurrence_count ? "true" : undefined}
          aria-describedby={errors.recurrence_count ? "f-recurrence-count-error" : undefined}
        />
        {@render fieldError("recurrence_count", "f-recurrence-count-error")}
      </div>
      <div class="field">
        <label for="f-recurrence-ends-on">Repeat until (YYYY-MM-DD)</label>
        <input
          id="f-recurrence-ends-on"
          name="recurrence_ends_on"
          type="text"
          value={val("recurrence_ends_on")}
          aria-invalid={errors.recurrence_ends_on ? "true" : undefined}
          aria-describedby={errors.recurrence_ends_on ? "f-recurrence-ends-on-error" : undefined}
        />
        {@render fieldError("recurrence_ends_on", "f-recurrence-ends-on-error")}
      </div>
    </fieldset>
    <div class="actions">
      <button type="submit" class="btn" data-testid="save-event">Create draft</button>
      <a href="/admin/events">Cancel</a>
    </div>
  </form>
  {@html '<p data-admin-save-status="" role="status" aria-live="polite" aria-atomic="true"></p>'}
  {@html textLimitsIsland}
  {@html editorIsland}
</section>
</AdminShell>
