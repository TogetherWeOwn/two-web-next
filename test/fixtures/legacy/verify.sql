-- Synthetic DDL only. Legacy columns used by verification, transcribed from
-- two-web Laravel migrations at 1b76d9b72adfe408b01c1bb1aee4363ebc516fce.
-- The caller owns a disposable schema and pins search_path before loading.
CREATE TABLE users (id bigint PRIMARY KEY, discord_id varchar(255) UNIQUE NOT NULL,
  username varchar(255) NOT NULL, avatar varchar(255), discord_joined_at timestamp,
  is_moderator boolean NOT NULL DEFAULT false, created_at timestamp, updated_at timestamp);
CREATE TABLE profiles (id bigint PRIMARY KEY, user_id bigint UNIQUE NOT NULL REFERENCES users(id),
  bio text, games jsonb NOT NULL DEFAULT '[]', timezone varchar(255), created_at timestamp, updated_at timestamp);
CREATE TABLE events (id bigint PRIMARY KEY, event_key varchar(26) UNIQUE NOT NULL,
  title varchar(255) NOT NULL, game varchar(255), description text, starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL, timezone varchar(64) NOT NULL DEFAULT 'UTC', location varchar(255),
  capacity integer, status varchar(255) NOT NULL DEFAULT 'draft', discord_event_id varchar(255),
  created_by bigint REFERENCES users(id), rsvp_open boolean NOT NULL DEFAULT true,
  recurrence_frequency varchar(16), recurrence_count integer, recurrence_ends_on date,
  parent_event_id bigint REFERENCES events(id), recurrence_index integer,
  agent_grant_id uuid, proof_marker varchar(255), agent_version integer NOT NULL DEFAULT 0,
  discord_sync_failed_at timestamp, discord_sync_failure_code varchar(64), created_at timestamp, updated_at timestamp);
CREATE TABLE rsvps (id bigint PRIMARY KEY, event_id bigint NOT NULL REFERENCES events(id),
  user_id bigint NOT NULL REFERENCES users(id), status varchar(255) NOT NULL,
  synced_to_discord_at timestamp, created_at timestamp, updated_at timestamp, UNIQUE(event_id, user_id));
CREATE TABLE featured_contents (id bigint PRIMARY KEY, title varchar(255) NOT NULL,
  body text, url varchar(255), image_url varchar(255), image_alt varchar(255),
  is_published boolean NOT NULL DEFAULT false, position integer NOT NULL DEFAULT 0,
  starts_at timestamp, ends_at timestamp, created_by bigint REFERENCES users(id), created_at timestamp, updated_at timestamp);
CREATE TABLE join_attempts (id bigint PRIMARY KEY, outcome varchar(255) NOT NULL,
  source varchar(64), request_id varchar(255), discord_id varchar(255), created_at timestamp, updated_at timestamp);
CREATE TABLE event_search_logs (id bigint PRIMARY KEY, normalized_query varchar(255) NOT NULL,
  result_count integer NOT NULL, occurred_at timestamp NOT NULL);
CREATE TABLE member_data_access_logs (id bigint PRIMARY KEY, viewer_discord_id varchar(255) NOT NULL,
  viewer_user_id bigint REFERENCES users(id), resource varchar(255) NOT NULL, action varchar(255) NOT NULL,
  subject_user_ids jsonb NOT NULL, subject_count integer NOT NULL, route varchar(255), occurred_at timestamp NOT NULL);
CREATE TABLE activity_log (id bigint PRIMARY KEY, log_name varchar(255), description text NOT NULL,
  subject_type varchar(255), subject_id bigint, causer_type varchar(255), causer_id bigint,
  properties json, event varchar(255), batch_uuid uuid, created_at timestamp, updated_at timestamp);
CREATE TABLE agent_event_grants (id uuid PRIMARY KEY, agent_id varchar(255) NOT NULL,
  company_id varchar(255) NOT NULL, guild_id varchar(255) NOT NULL, verifier_hash varchar(64) NOT NULL,
  expires_at timestamp, disabled_at timestamp, max_events integer NOT NULL DEFAULT 1, created_at timestamp, updated_at timestamp);
CREATE TABLE agent_event_audits (id bigint PRIMARY KEY, grant_id uuid REFERENCES agent_event_grants(id),
  operation varchar(32) NOT NULL, event_key varchar(26), idempotency_key varchar(255), payload_digest varchar(64),
  request_id varchar(255) NOT NULL, result varchar(16) NOT NULL, reason_code varchar(64), discord_event_id varchar(255),
  created_at timestamp, updated_at timestamp);
CREATE TABLE agent_event_idempotency_keys (id bigint PRIMARY KEY, grant_id uuid NOT NULL REFERENCES agent_event_grants(id),
  key varchar(255) NOT NULL, payload_digest varchar(64) NOT NULL, status smallint NOT NULL, body json NOT NULL,
  event_key varchar(26), created_at timestamp, updated_at timestamp, UNIQUE(grant_id, key));
