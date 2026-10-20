import postgres from "postgres";
import { requireGithubRunner, requireTestDatabase } from "./ci-only.mjs";

requireGithubRunner();
const sql = postgres(requireTestDatabase(process.env.DATABASE_URL), { max: 1 });
try {
  // A fresh service container per job; no truncate/drop against a shared DB.
  await sql`
    insert into events (event_key, title, description, purpose, starts_at, ends_at, timezone, status, capacity, rsvp_open)
    values ('01J00000000000000000000001', 'E2E Community Night', 'Disposable browser fixture',
      'A relaxed introduction for new Go players.', '2099-01-01T18:00:00Z', '2099-01-01T20:00:00Z', 'UTC', 'published', 10, true)
  `;
  // Past-aged archive row for e2e/past.spec.ts: published-then-ended, so the
  // local archive renders the list branch (page 1) and the out-of-range
  // refusal (page 2+). Never matched by the upcoming calendar list.
  await sql`
    insert into events (event_key, title, description, starts_at, ends_at, timezone, status, capacity, rsvp_open)
    values ('01J00000000000000000000002', 'E2E Past Night', 'Disposable past-archive fixture',
      '2020-01-01T18:00:00Z', '2020-01-01T20:00:00Z', 'UTC', 'published', 10, true)
  `;
  // Mid-month rows in two far-future months for e2e/calendar-month.spec.ts:
  // the seeded E2E fixture opens the default month on 2099-01, so 2099-05 is
  // a non-default month, and mid-month dates never leak into a neighbour
  // month's leading/trailing grid days. Titles stay at 17 chars or fewer so
  // the calendar grid renders them in full (grid titles truncate past 18).
  await sql`
    insert into events (event_key, title, description, starts_at, ends_at, timezone, status, capacity, rsvp_open)
    values ('01J00000000000000000000003', 'E2E Calendar May', 'Disposable calendar-month fixture',
      '2099-05-15T18:00:00Z', '2099-05-15T20:00:00Z', 'UTC', 'published', 10, true)
  `;
  await sql`
    insert into events (event_key, title, description, starts_at, ends_at, timezone, status, capacity, rsvp_open)
    values ('01J00000000000000000000004', 'E2E Calendar June', 'Disposable calendar-month fixture',
      '2099-06-15T18:00:00Z', '2099-06-15T20:00:00Z', 'UTC', 'published', 10, true)
  `;
} finally {
  await sql.end();
}
