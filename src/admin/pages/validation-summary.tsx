/** @jsxRuntime automatic */
/** @jsxImportSource hono/jsx */
import type { FC } from "hono/jsx";
import { validationSummary } from "../form-errors";

export const ValidationSummary: FC<{
  errors: Record<string, string>;
  kind: "event" | "featured";
  mode: "new" | "edit";
}> = ({ errors, kind, mode }) => {
  const entries = validationSummary(errors, kind, mode);
  if (entries.length === 0) return null;
  return (
    <div
      class="notice"
      role="alert"
      tabindex={-1}
      data-testid="form-errors"
      data-admin-validation-summary=""
      data-admin-save-summary=""
    >
      <p>Check the highlighted fields and try again.</p>
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
    </div>
  );
};
