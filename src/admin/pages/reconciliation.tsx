// Moderator reconciliation screens (contract v2 §7.4/§11).
//
// List: open stuck intents oldest-first (what needs a human now), then
// recently resolved (the audit evidence). Detail: the scalar facts a
// moderator needs to check Discord by hand, plus the resolve form. Copy never
// promises delivery and never exposes plumbing: members never see this page,
// and the guidance is "check Discord, then stamp what you did".
import type { FC } from "hono/jsx";
import type { StuckIntentRecord } from "../../jobs/reconciliation";
import { RECONCILIATION_NOTE_MAX } from "../reconciliation";
import { Field, Shell, val } from "./shell";

function iso(d: Date): string {
  return d.toISOString();
}

function lastOutcome(row: StuckIntentRecord): string {
  if (!row.lastCode) return "no wire answer (transport loss)";
  const status = row.lastStatus === null ? "no status" : `status ${row.lastStatus}`;
  return `${row.lastCode} · ${status}`;
}

export const ReconciliationPage: FC<{
  open: StuckIntentRecord[];
  resolved: StuckIntentRecord[];
}> = ({ open, resolved }) => (
  <Shell title="Reconciliation">
    <section>
      <h1>Reconciliation</h1>
      <p>
        Keyed bot changes that ended without confirmation. Check Discord by hand for each key, then
        stamp what you did. Never re-send from here: a fresh key would fork the bot&apos;s key log,
        which is exactly what these rows report.
      </p>
      <h2>Needs a human ({open.length})</h2>
      {open.length === 0 ? (
        <p>Nothing stuck. Every keyed change is confirmed or still retrying with its own key.</p>
      ) : (
        <div class="admin-table-scroll" role="region" aria-label="Open stuck intents" tabindex={0}>
          <table class="admin-table" data-testid="reconciliation-open-table">
            <thead>
              <tr>
                <th scope="col">Change</th>
                <th scope="col">Subject</th>
                <th scope="col">Stuck since</th>
                <th scope="col">Last outcome</th>
              </tr>
            </thead>
            <tbody>
              {open.map((row) => (
                <tr>
                  <td>
                    <a href={`/admin/reconciliation/${row.idempotencyKey}`}>{row.verb}</a>
                  </td>
                  <td>{row.subject}</td>
                  <td>
                    <time datetime={iso(row.firstSeenAt)}>{iso(row.firstSeenAt)}</time>
                  </td>
                  <td>{lastOutcome(row)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <h2>Recently resolved ({resolved.length})</h2>
      {resolved.length === 0 ? (
        <p>No manual reconciliations yet.</p>
      ) : (
        <div
          class="admin-table-scroll"
          role="region"
          aria-label="Resolved stuck intents"
          tabindex={0}
        >
          <table class="admin-table" data-testid="reconciliation-resolved-table">
            <thead>
              <tr>
                <th scope="col">Change</th>
                <th scope="col">Subject</th>
                <th scope="col">Resolved</th>
                <th scope="col">By</th>
              </tr>
            </thead>
            <tbody>
              {resolved.map((row) => (
                <tr>
                  <td>
                    <a href={`/admin/reconciliation/${row.idempotencyKey}`}>{row.verb}</a>
                  </td>
                  <td>{row.subject}</td>
                  <td>
                    {row.resolvedAt ? (
                      <time datetime={iso(row.resolvedAt)}>{iso(row.resolvedAt)}</time>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td>{row.resolvedBy ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  </Shell>
);

export const ReconciliationDetailPage: FC<{
  row: StuckIntentRecord;
  values?: Record<string, unknown>;
  errors?: Record<string, string>;
}> = ({ row, values = { resolution: "" }, errors = {} }) => (
  <Shell title={`Reconciliation — ${row.verb}`}>
    <section>
      <h1>{row.verb}</h1>
      <p>
        <a href="/admin/reconciliation">Back to reconciliation</a>
      </p>
      <dl>
        <div>
          <dt>Intent key</dt>
          <dd>{row.idempotencyKey}</dd>
        </div>
        <div>
          <dt>Subject</dt>
          <dd>{row.subject}</dd>
        </div>
        <div>
          <dt>Stuck since</dt>
          <dd>
            <time datetime={iso(row.firstSeenAt)}>{iso(row.firstSeenAt)}</time>
          </dd>
        </div>
        <div>
          <dt>Last attempt</dt>
          <dd>
            <time datetime={iso(row.lastAttemptAt)}>{iso(row.lastAttemptAt)}</time>
          </dd>
        </div>
        <div>
          <dt>Attempts</dt>
          <dd>{row.attempts}</dd>
        </div>
        <div>
          <dt>Last wire outcome</dt>
          <dd>{lastOutcome(row)}</dd>
        </div>
        {row.lastRequestId ? (
          <div>
            <dt>Bot request id</dt>
            <dd>{row.lastRequestId}</dd>
          </div>
        ) : null}
        <div>
          <dt>Status</dt>
          <dd>
            {row.resolvedAt
              ? `Resolved at ${iso(row.resolvedAt)} by ${row.resolvedBy ?? "unknown"}: ${row.resolution ?? ""}`
              : "Open — Discord may or may not carry this change. Check Discord before acting, then stamp what you did below."}
          </dd>
        </div>
      </dl>
    </section>
    {!row.resolvedAt ? (
      <section aria-labelledby="reconcile-resolve-heading">
        <h2 id="reconcile-resolve-heading">Reconcile by hand</h2>
        <p>
          Describe what you checked on Discord and what you did about it. Stamping resolves this
          key; the row stays as the audit evidence.
        </p>
        <form method="post" action={`/admin/reconciliation/${row.idempotencyKey}/resolve`}>
          <Field
            name="resolution"
            label="Resolution"
            errors={errors}
            hint={`What you verified on Discord and did about it. At most ${RECONCILIATION_NOTE_MAX} characters.`}
          >
            {(id) => (
              <input
                id={id}
                name="resolution"
                value={val(values, "resolution")}
                maxlength={RECONCILIATION_NOTE_MAX}
              />
            )}
          </Field>
          <div class="actions">
            <button class="btn" type="submit" data-testid="reconciliation-resolve">
              Stamp resolved
            </button>
          </div>
        </form>
      </section>
    ) : null}
  </Shell>
);
