-- TOG-9680 spike schema: RSVP + access-log shapes mirrored from two-web.
-- Sources (two-web @ main, 2026-09-29):
--   events/rsvps locking: app/Services/EventService.php rsvp() (lockForUpdate + capacity count + unique event+user)
--   rsvps table:          database/migrations/2026_08_19_000300_create_rsvps_table.php
--   access logs table:    database/migrations/2026_08_25_000050_create_member_data_access_logs_table.php
-- Run:  psql $DATABASE_URL -v spike_schema=w1_spike -f schema.sql   (see checks.py for the full harness)

SET search_path TO :"spike_schema";

CREATE TABLE spike_events (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_key   text NOT NULL UNIQUE,
    status      text NOT NULL,              -- 'published' rows are RSVP-open
    capacity    integer NULL,               -- NULL = uncapped
    starts_at   timestamptz NOT NULL,
    ends_at     timestamptz NOT NULL
);

CREATE TABLE spike_rsvps (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_id    bigint NOT NULL REFERENCES spike_events (id) ON DELETE CASCADE,
    user_id     bigint NOT NULL,
    status      text NOT NULL,              -- 'going' takes a seat
    created_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (event_id, user_id)              -- one answer per member per event
);

CREATE TABLE spike_access_logs (
    id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    viewer_discord_id   text NOT NULL,
    viewer_user_id      bigint NULL,
    resource            text NOT NULL,
    action              text NOT NULL,
    subject_user_ids    jsonb NOT NULL,      -- internal users.id values, never contents
    subject_count       integer NOT NULL,
    route               text NULL,          -- route name, never the URL
    occurred_at         timestamptz NOT NULL
);

CREATE INDEX spike_access_logs_viewer_window_idx
    ON spike_access_logs (viewer_discord_id, occurred_at);
CREATE INDEX spike_access_logs_occurred_at_idx
    ON spike_access_logs (occurred_at);

-- "Who looked at *this member*?" containment query needs GIN; jsonb_path_ops
-- matches the two-web migration exactly.
CREATE INDEX spike_access_logs_subject_user_ids_gin
    ON spike_access_logs USING gin (subject_user_ids jsonb_path_ops);
