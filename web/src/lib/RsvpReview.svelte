<script lang="ts">
import { rsvpPauseReviewCopy } from "../../../src/admin/rsvp-review";

let {
  title,
  targetId,
  action,
  testId,
}: {
  title: string;
  targetId: string;
  action: string;
  testId?: string;
} = $props();
const copy = rsvpPauseReviewCopy;
</script>

<details class="rsvp-review" data-testid="rsvp-pause-review">
  <summary aria-label={`${copy.summary}: ${title}`}>{copy.summary}</summary>
  <p>{copy.target}: <strong>{title}</strong></p>
  <p class="rsvp-review-id">ID: {targetId}</p>
  <p>{copy.consequence}</p>
  <p>{copy.keep}</p>
  <form method="post" {action}>
    <button type="submit" class="btn" data-testid={testId}>{copy.final}</button>
  </form>
</details>
