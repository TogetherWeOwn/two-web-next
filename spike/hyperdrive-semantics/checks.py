#!/usr/bin/env python3
"""TOG-9680 spike: verify the Postgres semantics behind the C1 zero-data-migration claim.

Checks (mirroring two-web shapes, see schema.sql header for file:line sources):
  (a) SELECT ... FOR UPDATE serialises two RSVP writers on one event row
  (b) pg_advisory_lock single-flight: xact-scoped mutual exclusion + session lock round-trip
  (c) jsonb containment over member_data_access_logs shape uses the GIN index

Target: a throwaway schema on agent-testdb (Postgres 17) or, once S1 lands, the
Neon staging branch URL. Never production. Usage:

    DATABASE_URL="host=agent-testdb port=5432 user=agent_test dbname=agent_test" python3 checks.py
    # Neon leg (after TOG-9679 delivers the branch):
    DATABASE_URL="<neon-staging-branch-url>" python3 checks.py --schema w1_spike_neon

Exit 0 + "RESULT: PASS" only when all three checks pass. Prints versions for the report.
"""
import argparse
import json
import os
import sys

import psycopg2
import psycopg2.errors

SCHEMA = "w1_spike"


def connect(url):
    return psycopg2.connect(url, connect_timeout=10)


def setup(conn):
    with conn.cursor() as cur:
        cur.execute(f"DROP SCHEMA IF EXISTS {SCHEMA} CASCADE")
        cur.execute(f"CREATE SCHEMA {SCHEMA}")
    conn.commit()
    schema_sql = os.path.join(os.path.dirname(os.path.abspath(__file__)), "schema.sql")
    with open(schema_sql, "rb") as f:
        sql = f.read().decode().replace(':"spike_schema"', SCHEMA)
    with conn.cursor() as cur:
        cur.execute(sql)
    conn.commit()


def teardown(conn):
    with conn.cursor() as cur:
        cur.execute(f"DROP SCHEMA IF EXISTS {SCHEMA} CASCADE")
    conn.commit()


def check_for_update(url):
    """(a) Second writer blocks on the event row lock; capacity count is right after commit."""
    t1 = connect(url)
    t2 = connect(url)
    try:
        c1 = t1.cursor()
        c1.execute(
            f"INSERT INTO {SCHEMA}.spike_events (event_key, status, capacity, starts_at, ends_at)"
            " VALUES ('evt-cap1', 'published', 1, now(), now() + interval '1 hour') RETURNING id"
        )
        event_id = c1.fetchone()[0]
        t1.commit()

        # T1 takes the row lock and holds it (mirrors EventService::rsvp lockForUpdate).
        c1.execute(f"SELECT id FROM {SCHEMA}.spike_events WHERE id = %s FOR UPDATE", (event_id,))

        # T2 must block on the same row: prove it with a bounded lock_timeout.
        c2 = t2.cursor()
        c2.execute("SET lock_timeout = '2s'")
        try:
            c2.execute(f"SELECT id FROM {SCHEMA}.spike_events WHERE id = %s FOR UPDATE", (event_id,))
            return False, "T2 acquired FOR UPDATE while T1 held the lock (no serialisation)"
        except psycopg2.errors.LockNotAvailable:
            t2.rollback()  # timed-out attempt leaves the txn aborted; reset it
        # T1 fills the single seat and commits; T2's post-commit count must see it.
        c1.execute(
            f"INSERT INTO {SCHEMA}.spike_rsvps (event_id, user_id, status) VALUES (%s, 11, 'going')",
            (event_id,),
        )
        t1.commit()

        c2.execute(
            f"SELECT count(*) FROM {SCHEMA}.spike_rsvps WHERE event_id = %s AND status = 'going'",
            (event_id,),
        )
        going = c2.fetchone()[0]
        t2.commit()
        if going != 1:
            return False, f"expected going=1 after T1 commit, saw {going}"
        # capacity=1 and going=1: the app's takesASeat check would now refuse T2 (EventAtCapacity).
        return True, "T2 blocked on row lock (lock_timeout 55P03); post-commit going=1, capacity=1 refuses second seat"
    finally:
        t1.close()
        t2.close()


def check_advisory(url):
    """(b) xact-scoped single-flight excludes a concurrent txn; session lock round-trips."""
    lock_key = 96801357  # arbitrary 32-bit spike key, schema-local meaning only
    c1 = connect(url)
    c2 = connect(url)
    try:
        a = c1.cursor()
        b = c2.cursor()
        # Transaction-scoped variant: the Hyperdrive-safe pattern (pooler returns +
        # RESETs connections, so session scope cannot be relied on; see findings.md).
        a.execute("BEGIN")
        a.execute("SELECT pg_advisory_xact_lock(%s)", (lock_key,))
        b.execute("BEGIN")
        b.execute("SELECT pg_try_advisory_xact_lock(%s)", (lock_key,))
        held = b.fetchone()[0]
        if held:
            return False, "concurrent txn acquired xact lock held by another txn"
        c1.commit()  # releases the xact lock
        b.execute("SELECT pg_try_advisory_xact_lock(%s)", (lock_key,))
        reacquired = b.fetchone()[0]
        c2.commit()
        if not reacquired:
            return False, "xact lock not acquirable after holder committed"
        # Session-scope round-trip on direct Postgres (works here; NOT portable to Hyperdrive pooling).
        s = c1.cursor()
        s.execute("SELECT pg_advisory_lock(%s)", (lock_key,))
        s.execute("SELECT pg_advisory_unlock(%s)", (lock_key,))
        unlocked = s.fetchone()[0]
        c1.commit()
        if not unlocked:
            return False, "session pg_advisory_unlock reported false"
        return True, "xact single-flight excludes concurrent txn; session lock/unlock round-trips on direct PG"
    finally:
        c1.close()
        c2.close()


def check_gin(url, rows=2000):
    """(c) 'Who looked at this member?' containment uses the GIN index."""
    conn = connect(url)
    try:
        cur = conn.cursor()
        cur.executemany(
            f"INSERT INTO {SCHEMA}.spike_access_logs"
            " (viewer_discord_id, resource, action, subject_user_ids, subject_count, route, occurred_at)"
            " VALUES (%s, 'member', 'view', %s, %s, 'members.show', now())",
            [
                (f"snowflake-{i % 50}", json.dumps([1000 + i, 2000 + (i % 97)]), 2)
                for i in range(rows)
            ],
        )
        # One row containing the investigation target.
        cur.execute(
            f"INSERT INTO {SCHEMA}.spike_access_logs"
            " (viewer_discord_id, resource, action, subject_user_ids, subject_count, route, occurred_at)"
            " VALUES ('snowflake-7', 'member', 'list', '[424242, 1001]', 2, 'members.index', now())"
        )
        conn.commit()
        cur.execute(f"ANALYZE {SCHEMA}.spike_access_logs")
        cur.execute(
            f"EXPLAIN (COSTS OFF) SELECT id FROM {SCHEMA}.spike_access_logs"
            " WHERE subject_user_ids @> '[424242]'::jsonb"
        )
        plan = "\n".join(r[0] for r in cur.fetchall())
        cur.execute(
            f"SELECT count(*) FROM {SCHEMA}.spike_access_logs"
            " WHERE subject_user_ids @> '[424242]'::jsonb"
        )
        hits = cur.fetchone()[0]
        conn.commit()
        if "spike_access_logs_subject_user_ids_gin" not in plan:
            return False, f"GIN index not used; plan was: {plan[:300]}"
        if hits != 1:
            return False, f"expected 1 containment hit, saw {hits}"
        return True, f"containment uses GIN index ({rows + 1} rows, 1 hit)"
    finally:
        conn.close()


def main():
    global SCHEMA
    ap = argparse.ArgumentParser()
    ap.add_argument("--schema", default=SCHEMA)
    ap.add_argument("--keep", action="store_true", help="leave the spike schema behind")
    args = ap.parse_args()
    SCHEMA = args.schema
    url = os.environ.get("DATABASE_URL", "host=agent-testdb port=5432 user=agent_test dbname=agent_test")

    admin = connect(url)
    try:
        with admin.cursor() as cur:
            cur.execute("SELECT version()")
            print("postgres:", cur.fetchone()[0])
        setup(admin)
        results = []
        for name, fn in [("(a) FOR UPDATE", check_for_update),
                         ("(b) advisory lock", check_advisory),
                         ("(c) jsonb+GIN", check_gin)]:
            try:
                ok, detail = fn(url)
            except Exception as e:  # fail loudly, never half-pass
                ok, detail = False, f"{type(e).__name__}: {e}"
            results.append((name, ok, detail))
            print(f"{name}: {'PASS' if ok else 'FAIL'} — {detail}")
        if not args.keep:
            teardown(admin)
    finally:
        admin.close()

    passed = sum(1 for _, ok, _ in results if ok)
    print(f"RESULT: {'PASS' if passed == 3 else 'FAIL'} ({passed}/3)")
    return 0 if passed == 3 else 1


if __name__ == "__main__":
    sys.exit(main())
