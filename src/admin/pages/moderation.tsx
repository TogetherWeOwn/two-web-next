// Moderation settings screen: one versioned form over the live hot keys,
// a read-only operator-only status panel, and explicit "not available"
// states for warn/strike escalation and mute-role config, which do not
// exist in the bot and are never invented here.

import type { FC } from "hono/jsx";
import type { ModerationPageModel } from "../moderation";
import { Field, Shell, val } from "./shell";

const dayOf = (iso: string): string => iso.match(/^(\d{4}-\d{2}-\d{2})/)?.[1] ?? iso;

export const ModerationPage: FC<{ model: ModerationPageModel }> = ({ model }) => {
  // Exactly one hot key is dashboard-editable today, so one hidden version
  // carries the optimistic-concurrency token. A future multi-key form needs
  // per-key version fields and a matching parser extension.
  const first = model.hotKeys[0]!;
  const values: Record<string, unknown> = Object.fromEntries(
    model.hotKeys.map((row) => [row.key, row.value]),
  );
  return (
    <Shell title="Moderation settings">
      <section>
        <h1>Moderation settings</h1>
        <p class="lead">
          Live bot settings. Changes apply within seconds, carry your dashboard identity, and are
          audited.
        </p>
        <form method="post" action="/admin/moderation">
          {model.hotKeys.map((row) => (
            <Field
              key={row.key}
              name={row.key}
              label={`Mention limit (${row.key})`}
              errors={{}}
              hint="How many mentions in a message trip automod. A whole number, 0 or more."
            >
              {(id) => (
                <input
                  id={id}
                  type="text"
                  inputmode="numeric"
                  name={row.key}
                  value={val(values, row.key)}
                  autocomplete="off"
                />
              )}
            </Field>
          ))}
          <input type="hidden" name="expected_version" value={String(first.version)} />
          <button type="submit">Save moderation settings</button>
        </form>
        <section data-testid="moderation-last-changed">
          <h2>Last changed</h2>
          <p>
            {first.updatedBy} · <time dateTime={first.updatedAt}>{dayOf(first.updatedAt)}</time>
          </p>
        </section>
        <section data-testid="moderation-envonly-status">
          <h2>Operator-only status</h2>
          <p>
            Reach and identity keys are set at deploy time. The dashboard shows them, never writes
            them.
          </p>
          <dl>
            {model.envOnly.map((row) => (
              <div key={row.key}>
                <dt>{row.key}</dt>
                <dd>{row.value}</dd>
              </div>
            ))}
          </dl>
        </section>
        <section data-testid="moderation-escalation-unavailable">
          <h2>Warn and strike escalation</h2>
          <p>Not available: the bot has no escalation config, so there is nothing to edit here.</p>
        </section>
        <section data-testid="moderation-mute-role-unavailable">
          <h2>Mute role</h2>
          <p>Not available: the bot has no mute-role config, so there is nothing to edit here.</p>
        </section>
      </section>
    </Shell>
  );
};
