// Shared by the builder and its exact-shape owner classifier. Keep member
// filters outside this event-wide FIFO window so they cannot renumber ranks.
export const rankedRosterPrefix =
  "select line.user_id, users.username, line.status, line.updated_at, line.position from ( select rsvps.user_id, rsvps.status, rsvps.updated_at, case when rsvps.status = 'waitlisted' then row_number() over (partition by rsvps.status order by rsvps.created_at, coalesce(rsvps.legacy_id, rsvps.id), rsvps.id)::int end as position from rsvps inner join events on events.id = rsvps.event_id where events.event_key =";
