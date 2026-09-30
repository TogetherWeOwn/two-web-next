-- Synthetic rows only. Final PostgreSQL DDL transcribed from TogetherWeOwn/two-web
-- at 2eaefb8dc7af6e7e9bf62fd561d09e8babf31ba4:
-- 0001_01_01_000000_create_users_table.php (users only),
-- 2026_08_19_000200_create_events_table.php, 2026_08_25_000100_correct_events_schema.php,
-- 2026_09_28_000100_add_recurrence_to_events_table.php,
-- 2026_09_28_000100_add_discord_sync_failure_to_events_table.php,
-- 2026_09_29_000200_add_rsvp_open_to_events_table.php,
-- 2026_08_19_000300_create_rsvps_table.php.
CREATE TABLE legacy.users (
    id bigserial PRIMARY KEY,
    discord_id varchar(255) NOT NULL UNIQUE,
    username varchar(255) NOT NULL,
    display_name varchar(255),
    avatar varchar(255),
    discord_synced_at timestamp,
    remember_token varchar(100),
    created_at timestamp,
    updated_at timestamp
);
CREATE TABLE legacy.events (
    id bigserial PRIMARY KEY,
    title varchar(255) NOT NULL,
    description text,
    starts_at timestamptz NOT NULL,
    ends_at timestamptz NOT NULL,
    location varchar(255),
    capacity integer,
    status varchar(255) NOT NULL DEFAULT 'draft',
    discord_event_id varchar(255) UNIQUE,
    created_by bigint REFERENCES legacy.users(id) ON DELETE SET NULL,
    created_at timestamp,
    updated_at timestamp,
    event_key varchar(26) NOT NULL UNIQUE,
    game varchar(255),
    timezone varchar(64) NOT NULL DEFAULT 'UTC',
    recurrence_frequency varchar(16),
    recurrence_count integer,
    recurrence_ends_on date,
    parent_event_id bigint REFERENCES legacy.events(id) ON DELETE SET NULL,
    recurrence_index integer,
    discord_sync_failed_at timestamp,
    discord_sync_failure_code varchar(64),
    rsvp_open boolean NOT NULL DEFAULT true
);
CREATE INDEX legacy_events_status_starts_at ON legacy.events(status, starts_at);
CREATE INDEX legacy_events_parent ON legacy.events(parent_event_id);
CREATE TABLE legacy.rsvps (
    id bigserial PRIMARY KEY,
    event_id bigint NOT NULL REFERENCES legacy.events(id) ON DELETE CASCADE,
    user_id bigint NOT NULL REFERENCES legacy.users(id) ON DELETE CASCADE,
    status varchar(255) NOT NULL,
    synced_to_discord_at timestamp,
    created_at timestamp,
    updated_at timestamp,
    UNIQUE(event_id, user_id)
);

INSERT INTO legacy.users(id, discord_id, username) VALUES
    (901, '100000000000000901', 'synthetic-going'),
    (902, '100000000000000902', 'synthetic-waitlisted'),
    (903, '100000000000000903', 'synthetic-not-imported');
-- Parent deliberately has a larger numeric ID than its children.
INSERT INTO legacy.events(id, event_key, title, game, description, starts_at, ends_at,
    timezone, location, capacity, status, rsvp_open, discord_event_id, created_by,
    created_at, updated_at, recurrence_frequency, recurrence_count, recurrence_ends_on,
    recurrence_index, discord_sync_failed_at, discord_sync_failure_code) VALUES
    (30, '01K00000000000000000000030', 'Synthetic Sunday series', 'Synthetic game',
     'Synthetic description', '2026-10-18T19:00:00Z', '2026-10-18T21:00:00Z',
     'Europe/London', 'Synthetic voice room', 1, 'published', false,
     '100000000000000030', 901, '2026-09-01 09:00:00', '2026-09-30 10:00:00',
     'weekly', 3, '2026-11-01', 1, '2026-09-29 12:00:00', 'synthetic_refusal');
INSERT INTO legacy.events(id, event_key, title, starts_at, ends_at, timezone, capacity,
    status, created_at, updated_at, parent_event_id, recurrence_index) VALUES
    (10, '01K00000000000000000000010', 'Synthetic DST child', '2026-10-25T20:00:00Z',
     '2026-10-25T22:00:00Z', 'Europe/London', 1, 'published',
     '2026-09-01 09:01:00', '2026-09-30 10:01:00', 30, 2),
    (20, '01K00000000000000000000020', 'Synthetic cancelled child', '2026-11-01T20:00:00Z',
     '2026-11-01T22:00:00Z', 'Europe/London', 1, 'cancelled',
     '2026-09-01 09:02:00', '2026-09-30 10:02:00', 30, 3),
    (40, '01K00000000000000000000040', 'Synthetic past one-off', '2026-09-01T10:00:00Z',
     '2026-09-01T12:00:00Z', 'UTC', NULL, 'past',
     '2026-08-31 09:00:00', '2026-09-01 12:01:00', NULL, NULL);
INSERT INTO legacy.rsvps(id, event_id, user_id, status, synced_to_discord_at, created_at, updated_at) VALUES
    (70, 10, 901, 'going', '2026-09-30 12:00:00', '2026-09-30 11:00:00', '2026-09-30 12:00:00'),
    (71, 10, 902, 'waitlisted', NULL, '2026-09-30 11:01:00', '2026-09-30 11:01:00'),
    (72, 20, 901, 'maybe', NULL, '2026-09-30 11:02:00', '2026-09-30 11:02:00'),
    (73, 30, 903, 'going', NULL, '2026-09-30 11:03:00', '2026-09-30 11:03:00');
