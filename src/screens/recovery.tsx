import type { FC } from "hono/jsx";
import { RecoveryShell } from "../page-shell";

export const Recovery: FC<{
  title: string;
  message: string;
  retryUrl: string;
  retryLabel: string;
  inviteUrl: string;
  supportReference?: string;
}> = ({ title, message, retryUrl, retryLabel, inviteUrl, supportReference }) => (
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
    {supportReference ? (
      <p class="support-reference">
        Support reference: <code data-testid="error-support-reference">{supportReference}</code>
      </p>
    ) : null}
  </RecoveryShell>
);
