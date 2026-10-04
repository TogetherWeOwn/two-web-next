// Baseline projections transcribed from frozen two-web migrations at
// 1b76d9b72adfe408b01c1bb1aee4363ebc516fce and Next's Drizzle schemas.
// Importers must resolve the explicit gaps before this can certify cutover.
export function defaultTableMap({ legacySchema = "public", nextSchema = "public", cutoff } = {}) {
  const schema = (name) => {
    if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error("invalid_schema");
    return `"${name}"`;
  };
  const legacy = schema(legacySchema);
  const next = schema(nextSchema);
  // A fixed cutoff is required; independently evaluating now() would compare
  // different retention windows across the two snapshots and importer run.
  if (
    !cutoff ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/.test(cutoff) ||
    !Number.isFinite(Date.parse(cutoff))
  )
    throw new Error("fixed_cutoff_required");
  const cutoffSql = `'${cutoff}'::timestamptz`;
  const field = (name, left = `l.${name}`, right = `n.${name}`) => ({
    name,
    legacy: left,
    next: right,
  });
  const timestamp = (name) => field(name, `l.${name} AT TIME ZONE 'UTC'`);
  const userId = (column, alias) =>
    `COALESCE(${alias}.discord_id, CASE WHEN l.${column} IS NOT NULL THEN 'unresolved-legacy-user:' || l.${column}::text END)`;
  const table = (name, keys, columns, extra = {}) => ({
    name,
    legacy: { from: `${legacy}."${name}" l` },
    next: { from: `${next}."${name}" n` },
    keys,
    columns,
    ...extra,
  });
  const id = () => [field("id", "l.id::text", "n.id::text")];
  const times = () => [timestamp("created_at"), timestamp("updated_at")];
  const retained = (name, time, keys, columns) =>
    table(name, keys, columns, {
      legacy: {
        from: `${legacy}."${name}" l`,
        where: `(l.${time} IS NULL OR (l.${time} AT TIME ZONE 'UTC') >= ${cutoffSql})`,
      },
      next: {
        from: `${next}."${name}" n`,
        where: `(n.${time} IS NULL OR n.${time} >= ${cutoffSql})`,
      },
    });
  return [
    table(
      "users",
      [field("discord_id", "l.discord_id", "n.id")],
      [
        field("username", "COALESCE(NULLIF(l.display_name, ''), l.username)"),
        field("avatar"),
        // Import policy (docs/import-users-profiles.md): non-null historical
        // join evidence imports as member, null as false.
        field("member", "(l.discord_joined_at IS NOT NULL)", "n.member"),
        ...times(),
      ],
    ),
    table(
      "profiles",
      [field("discord_id", userId("user_id", "u"), "n.user_id")],
      [
        field("bio"),
        field("games", "COALESCE(l.games::jsonb, '[]'::jsonb)"),
        field("timezone"),
        ...times(),
      ],
      {
        legacy: {
          from: `${legacy}."profiles" l LEFT JOIN ${legacy}."users" u ON u.id = l.user_id`,
        },
      },
    ),
    table(
      "events",
      [field("event_key")],
      [
        ...[
          "title",
          "game",
          "description",
          "timezone",
          "location",
          "capacity",
          "status",
          "discord_event_id",
          "rsvp_open",
          "recurrence_frequency",
          "recurrence_count",
          "recurrence_index",
        ].map((name) => field(name)),
        field("starts_at"),
        field("ends_at"),
        field(
          "recurrence_ends_on",
          "l.recurrence_ends_on::timestamp",
          "n.recurrence_ends_on::timestamp",
        ),
        field("created_by", userId("created_by", "u")),
        timestamp("discord_sync_failed_at"),
        field("discord_sync_failure_code"),
        // The importer refuses a batch containing agent attribution (grant ID,
        // proof marker or nonzero version), and Next's human events carry none.
        // Compare the legacy predicate to a literal so an attributed event is
        // a named-key mismatch, never silently excluded or a MATCH.
        field(
          "agent_attribution",
          "(l.agent_grant_id IS NOT NULL OR l.proof_marker IS NOT NULL OR l.agent_version IS DISTINCT FROM 0)::text",
          "'false'",
        ),
        field(
          "parent_event_key",
          "COALESCE(p.event_key, CASE WHEN l.parent_event_id IS NOT NULL THEN 'unresolved-legacy-event:' || l.parent_event_id::text END)",
          "p.event_key",
        ),
        ...times(),
      ],
      {
        legacy: {
          from: `${legacy}."events" l LEFT JOIN ${legacy}."users" u ON u.id = l.created_by LEFT JOIN ${legacy}."events" p ON p.id = l.parent_event_id`,
        },
        next: {
          from: `${next}."events" n LEFT JOIN ${next}."events" p ON p.id = n.parent_event_id`,
        },
      },
    ),
    table(
      "rsvps",
      [
        field(
          "event_key",
          "COALESCE(e.event_key, 'unresolved-legacy-event:' || l.event_id::text)",
          "e.event_key",
        ),
        field("discord_id", userId("user_id", "u"), "n.user_id"),
      ],
      [field("status"), timestamp("synced_to_discord_at"), ...times()],
      {
        legacy: {
          from: `${legacy}."rsvps" l LEFT JOIN ${legacy}."events" e ON e.id = l.event_id LEFT JOIN ${legacy}."users" u ON u.id = l.user_id`,
        },
        next: { from: `${next}."rsvps" n LEFT JOIN ${next}."events" e ON e.id = n.event_id` },
      },
    ),
    table(
      "featured_contents",
      id(),
      [
        ...["title", "body", "url", "image_url", "image_alt", "is_published", "position"].map(
          (name) => field(name),
        ),
        timestamp("starts_at"),
        timestamp("ends_at"),
        field("created_by", userId("created_by", "u")),
        ...times(),
      ],
      {
        legacy: {
          from: `${legacy}."featured_contents" l LEFT JOIN ${legacy}."users" u ON u.id = l.created_by`,
        },
      },
    ),
    retained("join_attempts", "created_at", id(), [
      ...["outcome", "source", "request_id", "discord_id"].map((name) => field(name)),
      timestamp("created_at"),
    ]),
    retained("event_search_logs", "occurred_at", id(), [
      field("normalized_query"),
      field("result_count"),
      timestamp("occurred_at"),
    ]),
    table(
      "member_data_access_logs",
      id(),
      [
        ...["viewer_discord_id", "resource", "action", "subject_count", "route"].map((name) =>
          field(name),
        ),
        field("viewer_user_id", userId("viewer_user_id", "u")),
        timestamp("occurred_at"),
        field(
          "subject_user_ids",
          `(SELECT COALESCE(jsonb_agg(COALESCE(su.discord_id, 'unresolved-legacy-user:' || subject.value) ORDER BY subject.ordinality), '[]'::jsonb)
        FROM jsonb_array_elements_text(l.subject_user_ids::jsonb) WITH ORDINALITY AS subject(value, ordinality)
        LEFT JOIN ${legacy}."users" su ON su.id::text = subject.value)`,
        ),
      ],
      {
        legacy: {
          from: `${legacy}."member_data_access_logs" l LEFT JOIN ${legacy}."users" u ON u.id = l.viewer_user_id`,
        },
      },
    ),
    table(
      "activity_log",
      id(),
      [
        field("log_name", "COALESCE(l.log_name, 'default')"),
        ...["description", "subject_type", "subject_id", "causer_id"].map((name) =>
          field(name, `l.${name}::text`, `n.${name}::text`),
        ),
        field("properties", "l.properties::jsonb"),
        ...times(),
      ],
      {
        mappingGaps: [
          "subject_id/causer_id and properties: importer must define morph-ID and Spatie dirty-map conversion.",
          "causer_type, event, batch_uuid: intentionally absent from Next; audit loss requires an explicit import disposition.",
        ],
      },
    ),
    table(
      "agent_event_grants",
      id(),
      [
        ...["agent_id", "company_id", "guild_id", "verifier_hash"].map((name) => field(name)),
        timestamp("expires_at"),
        timestamp("created_at"),
        field("disabled", "TRUE", "n.disabled_at IS NOT NULL"),
      ],
      {
        mappingGaps: [
          "max_events, updated_at: absent from Next; importer must record preservation/disposition.",
        ],
      },
    ),
    table(
      "agent_event_audits",
      id(),
      [
        ...[
          "grant_id",
          "operation",
          "event_key",
          "idempotency_key",
          "payload_digest",
          "request_id",
          "result",
          "reason_code",
        ].map((name) => field(name)),
        timestamp("created_at"),
      ],
      {
        mappingGaps: [
          "discord_event_id, updated_at: absent from Next; importer must record preservation/disposition.",
        ],
      },
    ),
    {
      ...retained("agent_event_idempotency_keys", "created_at", id(), [
        ...["grant_id", "key", "payload_digest", "status", "event_key"].map((name) => field(name)),
        field("body", "l.body::jsonb"),
        timestamp("created_at"),
      ]),
      mappingGaps: ["updated_at: absent from Next; importer must record preservation/disposition."],
    },
  ];
}
