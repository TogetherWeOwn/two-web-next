// Member-stats tuning constants, kept free of server imports on purpose: the
// Kit profile twin value-imports the milestones cap, and reaching it through
// stats.ts couples component code to the drizzle/member-read module graph.
// stats.ts re-exports both constants so existing server and test imports keep
// working unchanged.
export const MEMBER_STATS_BUDGET_MS = 500;
// Newest-N milestone window: the SQL read is capped at this many rows so one
// member cannot force an unbounded scan. Matches the sibling 100-row caps.
export const MEMBER_MILESTONES_CAP = 100;
// Visible milestone window: both profile twins render this many of the newest
// loaded rows directly and put any remainder behind a native disclosure, so a
// long history never buries the owner editor. This is presentation only; the
// SQL read cap above is unchanged.
export const MEMBER_MILESTONES_VISIBLE = 5;
