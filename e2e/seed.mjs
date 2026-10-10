import postgres from "postgres";
import { requireGithubRunner, requireTestDatabase } from "./ci-only.mjs";

requireGithubRunner();
const sql = postgres(requireTestDatabase(process.env.DATABASE_URL), { max: 1 });
try {
  // A fresh service container per job; no truncate/drop against a shared DB.
  await sql`
    insert into events (event_key, title, description, starts_at, ends_at, timezone, status, capacity, rsvp_open)
    values ('01J00000000000000000000001', 'E2E Community Night', 'Disposable browser fixture',
      '2099-01-01T18:00:00Z', '2099-01-01T20:00:00Z', 'UTC', 'published', 10, true)
  `;
  // Past-aged archive row for e2e/past.spec.ts: published-then-ended, so the
  // local archive renders the list branch (page 1) and the out-of-range
  // refusal (page 2+). Never matched by the upcoming calendar list.
  await sql`
    insert into events (event_key, title, description, starts_at, ends_at, timezone, status, capacity, rsvp_open)
    values ('01J00000000000000000000002', 'E2E Past Night', 'Disposable past-archive fixture',
      '2020-01-01T18:00:00Z', '2020-01-01T20:00:00Z', 'UTC', 'published', 10, true)
  `;
} finally {
  await sql.end();
}
