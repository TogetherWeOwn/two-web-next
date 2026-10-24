<script lang="ts">
import { terminalReviewCopy, type TerminalReviewKind } from "../../../src/admin/terminal-review";

let {
  kind,
  title,
  targetId,
  action,
  testId,
}: {
  kind: TerminalReviewKind;
  title: string;
  targetId: string;
  action: string;
  testId?: string;
} = $props();
const copy = $derived(terminalReviewCopy[kind]);
</script>

<details class="terminal-review">
  <summary aria-label={`${copy.summary}: ${title}`}>{copy.summary}</summary>
  <p>{copy.target}: <strong>{title}</strong></p>
  <p class="terminal-review-id">ID: {targetId}</p>
  <p>{copy.consequence}</p>
  <p>{copy.keep}</p>
  {#if copy.guidance}<p>{copy.guidance}</p>{/if}
  <form method="post" {action}>
    <button type="submit" class="btn" data-testid={testId}>{copy.final}</button>
  </form>
</details>
