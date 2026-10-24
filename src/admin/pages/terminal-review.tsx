import type { FC } from "hono/jsx";
import { terminalReviewCopy, type TerminalReviewKind } from "../terminal-review";

export const TerminalReview: FC<{
  kind: TerminalReviewKind;
  title: string;
  targetId: string;
  action: string;
  testId?: string;
}> = ({ kind, title, targetId, action, testId }) => {
  const copy = terminalReviewCopy[kind];
  return (
    <details class="terminal-review">
      <summary aria-label={`${copy.summary}: ${title}`}>{copy.summary}</summary>
      <p>
        {copy.target}: <strong>{title}</strong>
      </p>
      <p class="terminal-review-id">ID: {targetId}</p>
      <p>{copy.consequence}</p>
      <p>{copy.keep}</p>
      {copy.guidance ? <p>{copy.guidance}</p> : null}
      <form method="post" action={action}>
        <button type="submit" class="btn" data-testid={testId}>
          {copy.final}
        </button>
      </form>
    </details>
  );
};
