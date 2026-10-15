import type { FC } from "hono/jsx";
import { RecoveryShell } from "../page-shell";

export const Recovery: FC<{
  title: string;
  message: string;
  retryUrl: string;
  retryLabel: string;
  inviteUrl: string;
}> = ({ title, message, retryUrl, retryLabel, inviteUrl }) => (
  <RecoveryShell
    title={title}
    headingId="recovery-heading"
    headerCta={{ href: "/join", label: "Join with Discord" }}
  >
    <p class="lead">{message}</p>
    <p class="recovery-actions">
      <a class="btn" href={retryUrl} data-testid="recovery-retry">
        {retryLabel}
      </a>{" "}
      <a href={inviteUrl} data-testid="recovery-invite">
        Join with an invite link instead
      </a>
    </p>
  </RecoveryShell>
);
