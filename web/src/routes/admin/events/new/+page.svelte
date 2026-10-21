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
const errors = $derived(data.errors ?? {});
const hasErrors = $derived(data.hasErrors ?? Object.keys(errors).length > 0);
const val = (name: string) => data.values?.[name] ?? "";
const fieldAria = (name: string, hint?: string) => {
  const error = errors[name];
  const errorId = `f-${name.replaceAll("_", "-")}-error`;
  return {
    "aria-invalid": error ? true : undefined,
    "aria-describedby": error ? (hint ? `${hint} ${errorId}` : errorId) : hint,
  };
};
// A component-level <script> is Svelte's own; the island tags ride {@html}.
const islands =
  '<script type="module" src="/islands/admin-event-text-limits.js"></' +
  'script><script src="/islands/admin-event-editor.js" defer></' +
  "script>";
</script>

{#snippet fieldError(name: string, testId: string)}
  {#if errors[name]}
    <p id={`f-${name.replaceAll("_", "-")}-error`} class="error" role="alert" data-testid={testId}>
      {errors[name]}
    </p>
  {/if}
{/snippet}

<AdminShell title="New event">
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
        value={val("title")}
        data-event-text-limit={100}
        required
        {...fieldAria("title")}
      />
      {@render fieldError("title", "error-title")}
    </div>
    <div class="field">
      <label for="f-game">Game</label>
      <input
        id="f-game"
        name="game"
        value={val("game")}
        data-event-text-limit={100}
        {...fieldAria("game")}
      />
      {@render fieldError("game", "error-game")}
    </div>
    <div class="field">
      <label for="f-description">Description</label>
      <textarea
        id="f-description"
        name="description"
        rows={4}
        data-event-text-limit={1000}
        {...fieldAria("description")}
      >{val("description")}</textarea>
      {@render fieldError("description", "error-description")}
    </div>
    <div class="field">
      <label for="f-accessibility-notes">Accessibility notes</label>
      <textarea
        id="f-accessibility-notes"
        name="accessibility_notes"
        rows={4}
        data-event-text-limit={1000}
        aria-invalid={errors.accessibility_notes ? "true" : undefined}
        aria-describedby={errors.accessibility_notes
          ? "f-accessibility-notes-hint f-accessibility-notes-error"
          : "f-accessibility-notes-hint"}
      >{val("accessibility_notes")}</textarea>
      <p id="f-accessibility-notes-hint" class="hint">
        Optional; include only confirmed details, not personal contact information.
      </p>
      {@render fieldError("accessibility_notes", "error-accessibility_notes")}
    </div>
    <div class="field">
      <label for="f-starts-at">Starts (local wall time, YYYY-MM-DD HH:mm)</label>
      <input
        id="f-starts-at"
        name="starts_at"
        value={val("starts_at")}
        required
        {...fieldAria("starts_at")}
      />
      {@render fieldError("starts_at", "error-starts_at")}
    </div>
    <div class="field">
      <label for="f-ends-at">Ends (local wall time, YYYY-MM-DD HH:mm)</label>
      <input
        id="f-ends-at"
        name="ends_at"
        value={val("ends_at")}
        required
        {...fieldAria("ends_at")}
      />
      {@render fieldError("ends_at", "error-ends_at")}
    </div>
    <div class="field">
      <label for="f-timezone">Timezone</label>
      <input
        id="f-timezone"
        name="timezone"
        value={val("timezone") || "Europe/London"}
        {...fieldAria("timezone", "f-timezone-hint")}
      />
      <p id="f-timezone-hint" class="hint">
        The IANA zone the wall time above is typed in. Storage is UTC.
      </p>
      {@render fieldError("timezone", "error-timezone")}
    </div>
    <div class="field">
      <label for="f-location">Location</label>
      <input
        id="f-location"
        name="location"
        value={val("location")}
        data-event-text-limit={255}
        {...fieldAria("location")}
      />
      {@render fieldError("location", "error-location")}
    </div>
    <div class="field">
      <label for="f-organizer-name">Organizer display name (optional)</label>
      <input
        id="f-organizer-name"
        name="organizer_name"
        value={val("organizer_name")}
        data-event-text-limit={500}
        {...fieldAria("organizer_name", "f-organizer-name-hint")}
      />
      <p id="f-organizer-name-hint" class="hint">
        Use a name the organizer has agreed to show publicly. Do not enter contact details.
      </p>
      {@render fieldError("organizer_name", "error-organizer_name")}
    </div>
    <div class="field">
      <label for="f-join-url">Public joining link (optional)</label>
      <input
        id="f-join-url"
        name="join_url"
        type="url"
        value={val("join_url")}
        {...fieldAria("join_url", "f-join-url-hint")}
      />
      <p id="f-join-url-hint" class="hint">
        HTTPS or HTTP link visible to everyone. Never use attendee-only or private links.
      </p>
      {@render fieldError("join_url", "error-join_url")}
    </div>
    <div class="field">
      <label for="f-join-instructions">Public joining instructions (optional)</label>
      <textarea
        id="f-join-instructions"
        name="join_instructions"
        rows={4}
        data-event-text-limit={5000}
        {...fieldAria("join_instructions", "f-join-instructions-hint")}
      >{val("join_instructions")}</textarea>
      <p id="f-join-instructions-hint" class="hint">
        Share only verified details that are safe for anyone to see. Do not enter contact details.
      </p>
      {@render fieldError("join_instructions", "error-join_instructions")}
    </div>
    <div class="field">
      <label for="f-capacity">Capacity (empty = unlimited)</label>
      <input
        id="f-capacity"
        name="capacity"
        inputmode="numeric"
        value={val("capacity")}
        {...fieldAria("capacity")}
      />
      {@render fieldError("capacity", "error-capacity")}
    </div>
    <fieldset>
      <legend>Repeat</legend>
      <div class="field">
        <label for="f-recurrence-frequency">Repeats</label>
        <select
          id="f-recurrence-frequency"
          name="recurrence_frequency"
          {...fieldAria("recurrence_frequency", "f-recurrence-frequency-hint")}
        >
          <option value="" selected={val("recurrence_frequency") === ""}>Does not repeat</option>
          <option value="weekly" selected={val("recurrence_frequency") === "weekly"}>Weekly</option>
        </select>
        <p id="f-recurrence-frequency-hint" class="hint">
          Empty = a one-off event. Weeks keep the same wall time in the zone above across clock
          changes.
        </p>
        {@render fieldError("recurrence_frequency", "error-recurrence_frequency")}
      </div>
      <div class="field">
        <label for="f-recurrence-count">Occurrences (including the first, max 52)</label>
        <input
          id="f-recurrence-count"
          name="recurrence_count"
            inputmode="numeric"
          value={val("recurrence_count")}
          {...fieldAria("recurrence_count")}
        />
        {@render fieldError("recurrence_count", "error-recurrence_count")}
      </div>
      <div class="field">
        <label for="f-recurrence-ends-on">Repeat until (YYYY-MM-DD)</label>
        <input
          id="f-recurrence-ends-on"
          name="recurrence_ends_on"
            value={val("recurrence_ends_on")}
          {...fieldAria("recurrence_ends_on")}
        />
        {@render fieldError("recurrence_ends_on", "error-recurrence_ends_on")}
      </div>
    </fieldset>
    <div class="actions">
      <button type="submit" class="btn" data-testid="save-event">Create draft</button>
      <a href="/admin/events">Cancel</a>
    </div>
  </form>
  {@html islands}
</section>
</AdminShell>
