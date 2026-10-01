-- PostgreSQL transcription of TogetherWeOwn/two-web at
-- 2eaefb8dc7af6e7e9bf62fd561d09e8babf31ba4:
-- database/migrations/0001_01_01_000000_create_users_table.php:14-23
-- database/migrations/2026_08_19_000400_add_discord_role_fields_to_users_table.php:11-21
-- database/migrations/2026_08_19_000100_create_profiles_table.php:14-21
-- Loaded with search_path set to an isolated legacy fixture schema.
-- All rows and token sentinels below are synthetic; no member export is used.
CREATE TABLE users (
  id bigserial PRIMARY KEY,
  discord_id varchar(255) NOT NULL UNIQUE,
  username varchar(255) NOT NULL,
  display_name varchar(255),
  avatar varchar(255),
  discord_synced_at timestamp(0) without time zone,
  remember_token varchar(100),
  created_at timestamp(0) without time zone,
  updated_at timestamp(0) without time zone,
  is_moderator boolean NOT NULL DEFAULT false,
  discord_joined_at timestamp(0) without time zone
);
CREATE TABLE profiles (
  id bigserial PRIMARY KEY,
  user_id bigint NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  bio text,
  games jsonb NOT NULL DEFAULT '[]',
  timezone varchar(255),
  created_at timestamp(0) without time zone,
  updated_at timestamp(0) without time zone
);

INSERT INTO users (id, discord_id, username, display_name, avatar, discord_synced_at,
  remember_token, created_at, updated_at, is_moderator, discord_joined_at) VALUES
  (11, '900000000000000011', 'synthetic-member', 'Synthetic Display', 'https://cdn.discordapp.com/avatars/900000000000000011/abc123.png?size=1024',
   '2026-09-29 12:00:00', 'synthetic-remember-must-not-copy-a', '2026-08-01 10:00:00', '2026-09-29 12:00:00', true, '2026-07-01 12:00:00'),
  (22, '900000000000000022', 'synthetic-member', NULL, NULL,
   '2026-09-28 13:00:00', 'synthetic-remember-must-not-copy-b', '2026-08-02 11:00:00', '2026-09-28 13:00:00', false, NULL),
  (33, '900000000000000033', 'synthetic-no-profile', '', NULL,
   NULL, NULL, '2026-08-03 12:00:00', NULL, false, '2026-08-03 12:00:00');
INSERT INTO profiles (user_id, bio, games, timezone, created_at, updated_at) VALUES
  (11, 'Synthetic bio with unicode: café 🎮', '["Synthetic Game", "Another Game"]', 'Europe/London',
   '2026-08-04 14:00:00', '2026-09-28 15:00:00'),
  (22, NULL, '[]', NULL, '2026-08-05 16:00:00', NULL);
