// Adapted from the reconciliation screens in PR #2033 by Rick7C2.
import type { FC } from "hono/jsx";
import type { pgReconciliationReads } from "../reconciliation-reads";
import { Shell } from "./shell";

type Row = NonNullable<Awaited<ReturnType<ReturnType<typeof pgReconciliationReads>["get"]>>>;
const resolutions = {
  confirmed: "Confirmed",
  not_applied: "Not applied",
  superseded: "Superseded",
};

const Utc: FC<{ date: Date }> = ({ date }) => {
  const iso = date.toISOString();
  return <time datetime={iso}>{iso.slice(0, 19).replace("T", " ")}</time>;
};

const Rows: FC<{ rows: Row[]; resolved?: boolean; labelledBy: string }> = ({
  rows,
  resolved,
  labelledBy,
}) => (
  <div class="admin-table-scroll" role="region" aria-labelledby={labelledBy} tabindex={0}>
    <table class="admin-table">
      <thead>
        <tr>
          <th scope="col">Change</th>
          <th scope="col">{resolved ? "Resolved (UTC)" : "Stuck since (UTC)"}</th>
          <th scope="col">Subject</th>
          <th scope="col">{resolved ? "Resolution" : "Last outcome"}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr>
            <td>
              <a href={`/admin/reconciliation/${encodeURIComponent(row.idempotencyKey)}`}>
                {row.verb}
                <span class="sr-only">: {row.idempotencyKey}</span>
              </a>
            </td>
            <td class="admin-chronology">
              <Utc date={row.resolvedAt ?? row.firstSeenAt} />
            </td>
            <td>{row.subject ?? "—"}</td>
            <td>{resolved ? resolutionLabel(row.resolution) : (row.lastCode ?? "—")}</td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

function resolutionLabel(value: string | null) {
  return value && Object.hasOwn(resolutions, value)
    ? resolutions[value as keyof typeof resolutions]
    : "—";
}

export const ReconciliationPage: FC<{ open: Row[]; resolved: Row[] }> = ({ open, resolved }) => (
  <Shell title="Reconciliation">
    <section>
      <h1>Reconciliation</h1>
      <p>
        Review unconfirmed bot changes here and check Discord independently. This page is read-only.
      </p>
      <h2 id="reconciliation-open">Needs a human</h2>
      {open.length ? (
        <Rows rows={open} labelledBy="reconciliation-open" />
      ) : (
        <p>No open records found.</p>
      )}
      <h2 id="reconciliation-resolved">Recently resolved</h2>
      {resolved.length ? (
        <Rows rows={resolved} labelledBy="reconciliation-resolved" resolved />
      ) : (
        <p>No resolved records found.</p>
      )}
    </section>
  </Shell>
);

export const ReconciliationDetailPage: FC<{ row: Row }> = ({ row }) => (
  <Shell title="Reconciliation detail">
    <section class="reconciliation-detail">
      <p>
        <a href="/admin/reconciliation">Back to reconciliation</a>
      </p>
      <h1>{row.verb}</h1>
      {!row.resolvedAt ? (
        <p class="notice">
          Delivery was not confirmed. Check Discord independently. This page is read-only.
        </p>
      ) : null}
      <dl>
        {[
          ["Status", row.resolvedAt ? "Resolved" : "Open"],
          ["Intent key", row.idempotencyKey],
          ["Subject", row.subject ?? "—"],
          ["Stuck since (UTC)", <Utc date={row.firstSeenAt} />],
          ["Last attempt (UTC)", <Utc date={row.lastAttemptAt} />],
          ["Attempts", row.attempts],
          ["Last outcome", row.lastCode ?? "—"],
          ["Last HTTP status", row.lastStatus ?? "—"],
          ...(row.resolvedAt
            ? [
                ["Resolved (UTC)", <Utc date={row.resolvedAt} />],
                ["Recorded resolution", resolutionLabel(row.resolution)],
              ]
            : []),
        ].map(([label, value]) => (
          <>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </>
        ))}
      </dl>
      {row.resolvedAt && <p class="hint">Read-only. Resolved keys stay as audit evidence.</p>}
    </section>
  </Shell>
);
