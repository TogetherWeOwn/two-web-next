-- Synthetic only. DDL transcribed from TogetherWeOwn/two-web at
-- 2eaefb8dc7af6e7e9bf62fd561d09e8babf31ba4, database/migrations/:
-- 2026_09_03_190200_create_featured_contents_table.php
-- 2026_09_28_000100_add_image_alt_to_featured_contents_table.php
-- 2026_09_27_000100_create_join_attempts_table.php
-- 2026_09_28_000200_create_event_search_logs_table.php
-- The users stub exists only to exercise the nullable legacy creator FK.
create schema legacy;
create table legacy.users (id bigserial primary key, discord_id varchar(255) not null unique);
insert into legacy.users (id, discord_id) values (100, '123456789012345678');

create table legacy.featured_contents (
  id bigserial primary key,
  title varchar(255) not null,
  body text,
  url varchar(255),
  image_url varchar(255),
  image_alt varchar(255),
  is_published boolean not null default false,
  position integer not null default 0,
  starts_at timestamp,
  ends_at timestamp,
  created_by bigint references legacy.users(id) on delete set null,
  created_at timestamp,
  updated_at timestamp
);
create index featured_contents_is_published_position_index
  on legacy.featured_contents (is_published, position);

create table legacy.join_attempts (
  id bigserial primary key,
  outcome varchar(255) not null,
  source varchar(64),
  request_id varchar(255),
  discord_id varchar(255),
  created_at timestamp,
  updated_at timestamp
);
create index join_attempts_outcome_index on legacy.join_attempts (outcome);

create table legacy.event_search_logs (
  id bigserial primary key,
  normalized_query varchar(255) not null,
  result_count integer not null,
  occurred_at timestamp not null
);
create index event_search_logs_normalized_query_index on legacy.event_search_logs (normalized_query);
create index event_search_logs_occurred_at_index on legacy.event_search_logs (occurred_at);

-- Featured content is not prunable: an old published entry must survive.
-- Neither title nor URL is unique in the legacy schema.
insert into legacy.featured_contents
  (id, title, body, url, image_url, image_alt, is_published, position,
   starts_at, ends_at, created_by, created_at, updated_at)
values
  (1, 'Community night', 'Bring a friend.', 'https://example.invalid/night',
   'https://example.invalid/night.png', 'Synthetic game night poster', true, 2,
   '2026-09-01 18:00:00', '2026-10-01 23:00:00', 100,
   '2025-01-01 00:00:00', '2026-09-29 12:00:00'),
  (2, 'Community night', null, 'https://example.invalid/night', null, null, false, 0,
   null, null, null, '2026-09-29 12:00:00', null);

-- Reference clock: 2026-09-30T12:00:00Z. Cutoff: 2026-07-02T12:00:00Z.
-- One old row, one exactly at the boundary, two identical recent attempts,
-- and one nullable created_at (must not be revived with a fabricated time).
insert into legacy.join_attempts
  (id, outcome, source, request_id, discord_id, created_at, updated_at)
values
  (1, 'denied', 'landing', 'synthetic-old', null,
   '2026-07-02 11:59:59.999999', '2026-09-29 12:00:00'),
  (2, 'added', 'landing', 'synthetic-boundary', '123456789012345678',
   '2026-07-02 12:00:00', '2026-07-02 12:00:00'),
  (3, 'denied', null, null, null, '2026-09-29 12:00:00.123456', null),
  (4, 'denied', null, null, null, '2026-09-29 12:00:00.123456', null),
  (5, 'expired', null, null, null, null, null);

-- Duplicate searches are independent rendered searches, not a natural key.
insert into legacy.event_search_logs
  (id, normalized_query, result_count, occurred_at)
values
  (1, 'old game', 0, '2026-07-02 11:59:59.999999'),
  (2, 'boundary game', 0, '2026-07-02 12:00:00'),
  (3, 'game night', 2, '2026-07-02 12:00:00.000001'),
  (4, 'game night', 2, '2026-07-02 12:00:00.000001');
