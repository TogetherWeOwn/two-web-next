// Admin Echoes screens: the frozen bot-recorded attendance ledger.
//
// List: every `event_echoes` row, newest first — counts only, never member
// rows. Detail: the public facts, the host headline form (the one editable
// field; counts are never edited here), and the full member-minutes table,
// which is moderator-only (F20: per-member minutes never reach a
// member-facing surface).
import type { FC } from "hono/jsx";
import { ECHO_HEADLINE_MAX, type EchoRow, type ModeratorEchoMember } from "../../events/echoes";
import { Field, Shell, val } from "./shell";

export type AdminEchoRow = EchoRow & { eventTitle: string };

export const EchoesPage: FC<{ rows: AdminEchoRow[] }> = ({ rows }) => (
  <Shell title="Event echoes">
    <section>
      <h1>Event echoes</h1>
      <p>
        Frozen bot-recorded attendance. Counts stand as written; only the host headline below is
        editable, and only before the Discord post goes out. The post reads Confirming until the bot
        confirms delivery — never assume it landed. A delivery that never confirms lands on{" "}
        <a href="/admin/reconciliation">Reconciliation</a>.
      </p>
      {rows.length === 0 ? (
        <p>No echoes yet. The writer mints the first row when a bot window closes final.</p>
      ) : (
        <div class="admin-table-scroll" role="region" aria-label="Event echoes list" tabindex={0}>
          <table class="admin-table" data-testid="echoes-table">
            <thead>
              <tr>
                <th scope="col">Event</th>
                <th scope="col">Window ended</th>
                <th scope="col">Attended</th>
                <th scope="col">Peak</th>
                <th scope="col">Headline</th>
                <th scope="col">Discord post</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr>
                  <td>
                    <a href={`/admin/echoes/${row.id}`}>{row.eventTitle}</a>
                  </td>
                  <td>
                    <time datetime={row.windowEndsAt.toISOString()}>
                      {row.windowEndsAt.toISOString()}
                    </time>
                  </td>
                  <td>{row.attendedCount}</td>
                  <td>{row.peakConcurrent}</td>
                  <td>{row.headline ?? "—"}</td>
                  <td>{row.announcementPostedAt ? "posted" : "Confirming"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  </Shell>
);

export const EchoDetailPage: FC<{
  row: AdminEchoRow;
  members: ModeratorEchoMember[];
  values?: Record<string, unknown>;
  errors?: Record<string, string>;
}> = ({ row, members, values = { headline: row.headline ?? "" }, errors = {} }) => (
  <Shell title={`Echo — ${row.eventTitle}`}>
    <section>
      <h1>{row.eventTitle}</h1>
      <p>
        <a href={`/e/${encodeURIComponent(row.eventKey)}`}>View the event page</a> ·{" "}
        <a href="/admin/echoes">Back to echoes</a>
      </p>
      <dl>
        <div>
          <dt>Event key</dt>
          <dd>{row.eventKey}</dd>
        </div>
        <div>
          <dt>Window</dt>
          <dd>
            <time datetime={row.windowStartsAt.toISOString()}>
              {row.windowStartsAt.toISOString()}
            </time>{" "}
            –{" "}
            <time datetime={row.windowEndsAt.toISOString()}>{row.windowEndsAt.toISOString()}</time>
          </dd>
        </div>
        <div>
          <dt>Attendance threshold</dt>
          <dd>{row.thresholdMinutes} minutes in voice</dd>
        </div>
        <div>
          <dt>Attended</dt>
          <dd>{row.attendedCount}</dd>
        </div>
        <div>
          <dt>Peak concurrent</dt>
          <dd>{row.peakConcurrent}</dd>
        </div>
        <div>
          <dt>Rooms</dt>
          <dd>{row.rooms.length > 0 ? row.rooms.map((r) => r.name_at_close).join(" · ") : "—"}</dd>
        </div>
        <div>
          <dt>Discord post</dt>
          <dd>
            {row.announcementPostedAt
              ? `posted at ${row.announcementPostedAt.toISOString()}`
              : "Confirming — enqueue is not delivery; this stamps only on bot-confirmed success"}
          </dd>
        </div>
        <div>
          <dt>Counts</dt>
          <dd>
            {row.announcementPostedAt
              ? "Published — counts frozen. A correction means a new superseding record, never a silent edit."
              : "Pre-publication — counts can still be replaced by a re-pull."}
          </dd>
        </div>
      </dl>
    </section>
    <section aria-labelledby="echo-headline-heading">
      <h2 id="echo-headline-heading">Host headline</h2>
      <p>
        The one editable field — host-attested, e.g. tournament placement (“3rd of 24”). Blank
        clears back to the generated counts line.
      </p>
      <form method="post" action={`/admin/echoes/${row.id}/headline`}>
        <Field
          name="headline"
          label="Headline"
          errors={errors}
          hint={`At most ${ECHO_HEADLINE_MAX} characters. Counts are never edited here.`}
        >
          {(id) => (
            <input
              id={id}
              name="headline"
              value={val(values, "headline")}
              maxlength={ECHO_HEADLINE_MAX}
            />
          )}
        </Field>
        <div class="actions">
          <button class="btn" type="submit" data-testid="echo-headline-save">
            Save headline
          </button>
        </div>
      </form>
    </section>
    <section aria-labelledby="echo-members-heading">
      <h2 id="echo-members-heading">Played minutes (moderators only)</h2>
      {members.length === 0 ? (
        <p>No member rows on this echo.</p>
      ) : (
        <div class="admin-table-scroll" role="region" aria-label="Echo member rows" tabindex={0}>
          <table class="admin-table" data-testid="echo-members-table">
            <thead>
              <tr>
                <th scope="col">Member</th>
                <th scope="col">Minutes</th>
                <th scope="col">Sessions</th>
                <th scope="col">Attended</th>
              </tr>
            </thead>
            <tbody>
              {members.map((m) => (
                <tr>
                  <td>
                    <a href={`/members/${encodeURIComponent(m.userId)}`}>{m.userId}</a>
                  </td>
                  <td>{m.minutes}</td>
                  <td>{m.sessions}</td>
                  <td>{m.attended ? "yes" : "below threshold"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  </Shell>
);
