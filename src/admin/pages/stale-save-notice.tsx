import type { FC } from "hono/jsx";
import { validationSummary } from "../form-errors";

export const StaleSaveNotice: FC<{
  kind: "event" | "featured";
  action: string;
  updatedAt?: Date;
  unverified?: boolean;
  errors: Record<string, string>;
}> = ({ kind, action, updatedAt, unverified, errors }) => {
  const entries = validationSummary(errors, kind, "edit");
  const savedAt =
    updatedAt && Number.isFinite(updatedAt.getTime()) ? updatedAt.toISOString() : null;
  return (
    <div
      class="notice"
      role="alert"
      tabindex={-1}
      data-testid="stale-save"
      data-admin-validation-summary=""
    >
      <p>
        <strong>
          {unverified
            ? "This form’s saved version could not be verified."
            : `Someone else saved this ${kind === "event" ? "event" : "featured slot"} after you opened it.`}
        </strong>{" "}
        Your changes were not saved. They are still in the form below.
      </p>
      {savedAt ? (
        <p>
          Latest save: <time datetime={savedAt}>{savedAt}</time> (UTC).
        </p>
      ) : null}
      {entries.length ? (
        <>
          <p>Also fix before saving:</p>
          <ul>
            {entries.map(({ key, message, label, target }) => (
              <li key={key}>
                {target ? (
                  <a href={`#${target}`}>
                    {label}: {message}
                  </a>
                ) : (
                  message
                )}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      <div class="actions">
        <a href={action} target="_blank" rel="noopener" data-testid="stale-open-latest">
          Open the latest version in a new tab
        </a>
        <a href={action} data-testid="stale-discard-draft">
          Discard my changes and load the latest version
        </a>
      </div>
      <p>
        To keep your changes, copy them into the latest version and save there. Saving this page
        again will be refused, because it is based on the older version.
      </p>
    </div>
  );
};
