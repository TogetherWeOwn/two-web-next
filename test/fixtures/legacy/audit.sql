-- Synthetic data only. DDL transcribed from TogetherWeOwn/two-web at
-- 2eaefb8dc7af6e7e9bf62fd561d09e8babf31ba4, database/migrations:
-- 2026_08_25_000050_create_member_data_access_logs_table.php
-- 2026_09_03_190137_create_activity_log_table.php
-- 2026_09_03_190138_add_event_column_to_activity_log_table.php
-- 2026_09_03_190139_add_batch_uuid_column_to_activity_log_table.php
-- 2026_09_27_000001_create_agent_event_grant_tables.php
-- Laravel timestamp()/timestamps() are timestamp without time zone on Postgres.
CREATE SCHEMA legacy;
CREATE TABLE legacy.users (id bigserial PRIMARY KEY);
INSERT INTO legacy.users (id) VALUES (91001);

CREATE TABLE legacy.member_data_access_logs (
  id bigserial PRIMARY KEY,
  viewer_discord_id varchar(255) NOT NULL,
  viewer_user_id bigint REFERENCES legacy.users(id) ON DELETE SET NULL,
  resource varchar(255) NOT NULL,
  action varchar(255) NOT NULL,
  subject_user_ids jsonb NOT NULL,
  subject_count integer NOT NULL,
  route varchar(255),
  occurred_at timestamp NOT NULL
);
CREATE INDEX ON legacy.member_data_access_logs (viewer_discord_id, occurred_at);
CREATE INDEX ON legacy.member_data_access_logs (occurred_at);
CREATE INDEX ON legacy.member_data_access_logs USING gin (subject_user_ids jsonb_path_ops);
INSERT INTO legacy.member_data_access_logs VALUES
  (92001, '100000000000000001', 91001, 'member', 'view', '[91001]', 1, 'admin.members.view', '2026-09-01 10:11:12.123456'),
  (92002, 'unauthenticated', NULL, 'member', 'list', '[]', 0, NULL, '2026-09-02 10:11:12.654321');

CREATE TABLE legacy.activity_log (
  id bigserial PRIMARY KEY,
  log_name varchar(255),
  description text NOT NULL,
  subject_type varchar(255),
  subject_id bigint,
  causer_type varchar(255),
  causer_id bigint,
  properties json,
  created_at timestamp,
  updated_at timestamp,
  event varchar(255),
  batch_uuid uuid
);
CREATE INDEX ON legacy.activity_log (subject_type, subject_id);
CREATE INDEX ON legacy.activity_log (causer_type, causer_id);
CREATE INDEX ON legacy.activity_log (log_name);
INSERT INTO legacy.activity_log VALUES
  (93001, 'default', 'Synthetic member viewed', 'App\Models\User', 91001,
   'App\Models\User', 91001, '{"attributes":{"synthetic":true}}',
   '2026-09-01 10:11:12.123456', '2026-09-01 10:11:12.234567', 'viewed',
   '11111111-1111-4111-8111-111111111111'),
  (93002, NULL, 'Synthetic system action', NULL, NULL, NULL, NULL, NULL,
   '2026-09-02 10:11:12.654321', NULL, NULL, NULL);

CREATE TABLE legacy.agent_event_grants (
  id uuid PRIMARY KEY,
  agent_id varchar(255) NOT NULL,
  company_id varchar(255) NOT NULL,
  guild_id varchar(255) NOT NULL,
  verifier_hash varchar(64) NOT NULL UNIQUE,
  expires_at timestamp,
  disabled_at timestamp,
  max_events integer NOT NULL DEFAULT 1,
  created_at timestamp,
  updated_at timestamp
);
CREATE INDEX ON legacy.agent_event_grants (agent_id);
INSERT INTO legacy.agent_event_grants VALUES
  ('22222222-2222-4222-8222-222222222222', 'synthetic-agent', 'synthetic-company',
   '100000000000000002', repeat('a', 64), '2026-10-10 00:00:00', NULL, 1,
   '2026-09-01 10:11:12.123456', '2026-09-01 10:11:12.234567'),
  ('33333333-3333-4333-8333-333333333333', 'synthetic-disabled-agent', 'synthetic-company',
   '100000000000000002', repeat('b', 64), NULL, '2026-09-02 00:00:00', 1,
   '2026-09-01 10:11:12.123456', '2026-09-02 00:00:00');

CREATE TABLE legacy.agent_event_idempotency_keys (
  id bigserial PRIMARY KEY,
  grant_id uuid NOT NULL REFERENCES legacy.agent_event_grants(id) ON DELETE CASCADE,
  key varchar(255) NOT NULL,
  payload_digest varchar(64) NOT NULL,
  status smallint NOT NULL,
  body json NOT NULL,
  event_key varchar(26),
  created_at timestamp,
  updated_at timestamp,
  UNIQUE (grant_id, key)
);
INSERT INTO legacy.agent_event_idempotency_keys VALUES
  (94001, '22222222-2222-4222-8222-222222222222', 'synthetic-recent', repeat('c', 64),
   201, '{"event_key":"01K5SYNTHETIC00000000000001"}', '01K5SYNTHETIC00000000000001',
   '2026-09-29 00:00:00.123456', '2026-09-29 00:00:00.234567'),
  (94002, '22222222-2222-4222-8222-222222222222', 'synthetic-old', repeat('d', 64),
   200, '{"ok":true}', NULL, '2026-01-01 00:00:00', '2026-01-01 00:00:00');

CREATE TABLE legacy.agent_event_audits (
  id bigserial PRIMARY KEY,
  grant_id uuid REFERENCES legacy.agent_event_grants(id) ON DELETE SET NULL,
  operation varchar(32) NOT NULL,
  event_key varchar(26),
  idempotency_key varchar(255),
  payload_digest varchar(64),
  request_id varchar(255) NOT NULL,
  result varchar(16) NOT NULL,
  reason_code varchar(64),
  discord_event_id varchar(255),
  created_at timestamp,
  updated_at timestamp
);
CREATE INDEX ON legacy.agent_event_audits (grant_id, created_at);
CREATE INDEX ON legacy.agent_event_audits (event_key);
INSERT INTO legacy.agent_event_audits VALUES
  (95001, '22222222-2222-4222-8222-222222222222', 'create', '01K5SYNTHETIC00000000000001',
   'synthetic-recent', repeat('c', 64), 'synthetic-request', 'accepted', NULL,
   '100000000000000003', '2026-09-29 00:00:00.123456', '2026-09-29 00:00:00.234567'),
  (95002, NULL, 'create', NULL, NULL, NULL, 'synthetic-denial', 'denied',
   'missing_credential', NULL, '2026-09-29 01:00:00.654321', NULL);
