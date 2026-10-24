<script lang="ts">
import AdminShell from "#lib/AdminShell.svelte";
import type { PageProps } from "./$types";

// Markup contract of JoinAttemptPage (src/admin/pages/join-attempts.tsx):
// the back link, the Outcome/Trace headings and definition terms, the UTC
// <time datetime> instant, and the em-dash fallbacks for missing trace
// fields are shared, so the existing admin E2E selectors still apply when
// this route owns traffic. Values arrive from the load in the exact Hono
// shape with the instant pre-rendered as an ISO string, exactly as the Hono
// page emits it. Svelte escapes every value on render, like the Hono JSX
// shell, so adversarial trace identifiers render as text, never markup.
// (Wording here avoids bare Tailwind utility names: the v4 scanner lifts
// candidates from Svelte sources and would otherwise emit unused rules for
// any it finds into the client stylesheet.)
// No <script> island: the Hono detail page ships no JavaScript, so this page
// carries none either (csr=false comes from the admin group layout).
let { data }: PageProps = $props();
const view = $derived(data.view);
</script>

<AdminShell title={`Join attempt ${view.id}`} restoredWrite={data.restoredWrite}>
<section aria-labelledby="join-attempt-heading">
  <p>
    <a href="/admin/join-attempts">Back to join attempts</a>
  </p>
  <h1 id="join-attempt-heading">Join attempt {view.id}</h1>
  <p class="hint">Read-only. Attempted at and trace identifiers are shown as recorded.</p>
  <h2>Outcome</h2>
  <dl>
    <dt>Outcome</dt>
    <dd>{view.outcome}</dd>
    <dt>Source</dt>
    <dd>{view.source ?? "—"}</dd>
    <dt>Attempted at (UTC)</dt>
    <dd>
      <time datetime={view.createdAt}>{view.createdAt}</time>
    </dd>
  </dl>
  <h2>Trace</h2>
  <dl>
    <dt>Request ID</dt>
    <dd>{view.requestId ?? "—"}</dd>
    <dt>Discord ID</dt>
    <dd>{view.discordId ?? "—"}</dd>
  </dl>
</section>
</AdminShell>
