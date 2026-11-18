-- Synthetic browser-evidence rows for the disposable CI database only.
insert into bot_reconciliation_intents
  (idempotency_key, verb, subject, attempts, first_seen_at, last_attempt_at, resolved_at, resolution)
values ('e2e00000-0000-4000-8000-00000000a001', 'event.upsert', 'synthetic_open', 2, '2030-01-01', '2030-01-02', null, null),
  ('e2e00000-0000-4000-8000-00000000b001', 'announcement.post', 'synthetic_resolved', 1, '2030-01-01', '2030-01-02', '2030-01-03', 'superseded');

-- Installed as a trigger by the browser spec only after the healthy captures.
-- Fail the second list receipt and the detail receipt, not the open read.
create function e2e_reconciliation_receipt_fail() returns trigger language plpgsql as $$
begin
  if new.causer_id = '900000000000009101' and new.description = 'bot-reconciliation.read'
      and new.event in ('list_resolved', 'view') then
    raise exception 'synthetic receipt failure';
  end if;
  return new;
end $$;
