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
// A component-level <script> is Svelte's own; the island tags ride {@html}.
const islands =
  '<p data-admin-save-status="" role="status" aria-live="polite" aria-atomic="true"></p>' +
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

{#snippet detail(name: string, label: string, hint: string, limit: number, type?: string)}
  {@const id = `f-${name.replaceAll("_", "-")}`}
  <div class="field">
    <label for={id}>{label}</label>
    {#if type === ""}
      <textarea
        {id}
        {name}
        rows={4}
        data-event-text-limit={limit}
        aria-invalid={errors[name] ? "true" : undefined}
        aria-describedby={errors[name] ? `${id}-hint ${id}-error` : `${id}-hint`}
      >{val(name)}</textarea>
    {:else}
      <input
        {id}
        {name}
        {type}
        value={val(name)}
        data-event-text-limit={limit || undefined}
        aria-invalid={errors[name] ? "true" : undefined}
        aria-describedby={errors[name] ? `${id}-hint ${id}-error` : `${id}-hint`}
      />
    {/if}
    <p id={`${id}-hint`} class="hint">{hint}</p>
    {@render fieldError(name, `error-${name}`)}
  </div>
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
        aria-invalid={errors.title ? "true" : undefined}
        aria-describedby={errors.title ? "f-title-error" : undefined}
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
        aria-invalid={errors.game ? "true" : undefined}
        aria-describedby={errors.game ? "f-game-error" : undefined}
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
        aria-invalid={errors.description ? "true" : undefined}
        aria-describedby={errors.description ? "f-description-error" : undefined}
      >{val("description")}</textarea>
      {@render fieldError("description", "error-description")}
    </div>
    {@render detail("accessibility_notes", "Accessibility notes", "Optional; include only confirmed details, not personal contact information.", 1000, "")}
    <div class="field">
      <label for="f-starts-at">Starts (local wall time, YYYY-MM-DD HH:mm)</label>
      <input
        id="f-starts-at"
        name="starts_at"
        value={val("starts_at")}
        required
        aria-invalid={errors.starts_at ? "true" : undefined}
        aria-describedby={errors.starts_at ? "f-starts-at-error" : undefined}
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
        aria-invalid={errors.ends_at ? "true" : undefined}
        aria-describedby={errors.ends_at ? "f-ends-at-error" : undefined}
      />
      {@render fieldError("ends_at", "error-ends_at")}
    </div>
    <div class="field">
      <label for="f-timezone">Timezone</label>
      <input
        id="f-timezone"
        name="timezone"
        value={val("timezone") || "Europe/London"}
        aria-invalid={errors.timezone ? "true" : undefined}
        aria-describedby={errors.timezone ? "f-timezone-hint f-timezone-error" : "f-timezone-hint"}
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
        aria-invalid={errors.location ? "true" : undefined}
        aria-describedby={errors.location ? "f-location-error" : undefined}
      />
      {@render fieldError("location", "error-location")}
    </div>
    {@render detail("organizer_name", "Organizer display name (optional)", "Use a name the organizer has agreed to show publicly. Do not enter contact details.", 500)}
    {@render detail("join_url", "Public joining link (optional)", "HTTPS or HTTP link visible to everyone. Never use attendee-only or private links.", 0, "url")}
    {@render detail("join_instructions", "Public joining instructions (optional)", "Share only verified details that are safe for anyone to see. Do not enter contact details.", 5000, "")}
    <div class="field">
      <label for="f-capacity">Capacity (empty = unlimited)</label>
      <input
        id="f-capacity"
        name="capacity"
        inputmode="numeric"
        value={val("capacity")}
        aria-invalid={errors.capacity ? "true" : undefined}
        aria-describedby={errors.capacity ? "f-capacity-error" : undefined}
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
          aria-invalid={errors.recurrence_frequency ? "true" : undefined}
          aria-describedby={errors.recurrence_frequency ? "f-recurrence-frequency-hint f-recurrence-frequency-error" : "f-recurrence-frequency-hint"}
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
          aria-invalid={errors.recurrence_count ? "true" : undefined}
          aria-describedby={errors.recurrence_count ? "f-recurrence-count-error" : undefined}
        />
        {@render fieldError("recurrence_count", "error-recurrence_count")}
      </div>
      <div class="field">
        <label for="f-recurrence-ends-on">Repeat until (YYYY-MM-DD)</label>
        <input
          id="f-recurrence-ends-on"
          name="recurrence_ends_on"
          value={val("recurrence_ends_on")}
          aria-invalid={errors.recurrence_ends_on ? "true" : undefined}
          aria-describedby={errors.recurrence_ends_on ? "f-recurrence-ends-on-error" : undefined}
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
