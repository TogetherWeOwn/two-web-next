CREATE TABLE public.events (
  id integer PRIMARY KEY, starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL,
  status text NOT NULL, rsvp_open boolean NOT NULL, capacity integer,
  sync_revision bigint NOT NULL, synced_revision bigint NOT NULL
);
CREATE TABLE public.rsvps (
  id integer PRIMARY KEY, event_id integer NOT NULL REFERENCES public.events,
  user_id text NOT NULL, status text NOT NULL, created_at timestamptz NOT NULL,
  legacy_id bigint, synced_to_discord_at timestamptz
);
INSERT INTO public.events VALUES
  (5, '2026-01-01 00:00:00.000001+00', '2026-01-01 02:00+00', 'published', true, NULL, 9007199254740993, 0);
INSERT INTO public.rsvps VALUES
  (9, 5, 'synthetic-private-member', 'going', '2026-01-01 00:00+00', NULL, NULL);
