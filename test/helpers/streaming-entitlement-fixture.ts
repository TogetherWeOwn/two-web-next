// Streaming entitlement test fixture (S2 subscriptions slice).
//
// Test-only helper owned by the subscriptions acceptance card. The Builder builds
// on this card's branch and MUST NOT edit this file; later streaming slices (S3+)
// import `ensureEntitlementOff` to start from a known entitlement-off state.
//
// Requires the Builder's `subscriptions` migration (spec section 4: user_id PK/FK,
// stripe_customer_id, stripe_subscription_id UNIQUE, tier, status,
// current_period_start/end, cancel_at_period_end, created_at/updated_at). Every
// helper throws a clear BUILDER-tagged error until that table exists.
import type { Sql } from "postgres";

export const STREAMING_GRACE_PERIOD_DAYS = 3;

export type StreamingTier = "basic" | "plus";

export type StreamingSubscriptionStatus =
  | "trialing"
  | "active"
  | "past_due"
  | "canceled"
  | "paused";

export type SeedSubscriptionInput = {
  userId: string;
  stripeCustomerId?: string;
  stripeSubscriptionId?: string;
  tier?: StreamingTier;
  status?: StreamingSubscriptionStatus | string;
  currentPeriodStart?: Date;
  currentPeriodEnd?: Date;
  cancelAtPeriodEnd?: boolean;
};

export type SeededSubscriptionRow = {
  userId: string;
  stripeCustomerId: string;
  stripeSubscriptionId: string;
  tier: string;
  status: string;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  cancelAtPeriodEnd: boolean;
};

const MISSING_TABLE_MESSAGE =
  "BUILDER: subscriptions table missing; land the S2 migration (spec section 4) " +
  "with user_id PK/FK, stripe_customer_id, stripe_subscription_id UNIQUE, tier, " +
  "status, current_period_start/end, cancel_at_period_end.";

export async function subscriptionsTableExists(sql: Sql): Promise<boolean> {
  const rows = await sql<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_name = 'subscriptions'
    ) AS exists`;
  return rows[0]?.exists === true;
}

async function assertSubscriptionsTable(sql: Sql): Promise<void> {
  if (!(await subscriptionsTableExists(sql))) throw new Error(MISSING_TABLE_MESSAGE);
}

export async function seedSubscription(
  sql: Sql,
  input: SeedSubscriptionInput,
): Promise<SeededSubscriptionRow> {
  await assertSubscriptionsTable(sql);
  const now = Date.now();
  const row: SeededSubscriptionRow = {
    userId: input.userId,
    stripeCustomerId: input.stripeCustomerId ?? `cus_test_${input.userId}`,
    stripeSubscriptionId: input.stripeSubscriptionId ?? `sub_test_${input.userId}`,
    tier: input.tier ?? "basic",
    status: input.status ?? "active",
    currentPeriodStart: input.currentPeriodStart ?? new Date(now - 86400000),
    currentPeriodEnd: input.currentPeriodEnd ?? new Date(now + 30 * 86400000),
    cancelAtPeriodEnd: input.cancelAtPeriodEnd ?? false,
  };
  await sql`
    INSERT INTO subscriptions (
      user_id, stripe_customer_id, stripe_subscription_id, tier, status,
      current_period_start, current_period_end, cancel_at_period_end
    ) VALUES (
      ${row.userId}, ${row.stripeCustomerId}, ${row.stripeSubscriptionId}, ${row.tier},
      ${row.status}, ${row.currentPeriodStart}, ${row.currentPeriodEnd}, ${row.cancelAtPeriodEnd}
    )
    ON CONFLICT (user_id) DO UPDATE SET
      stripe_customer_id = EXCLUDED.stripe_customer_id,
      stripe_subscription_id = EXCLUDED.stripe_subscription_id,
      tier = EXCLUDED.tier,
      status = EXCLUDED.status,
      current_period_start = EXCLUDED.current_period_start,
      current_period_end = EXCLUDED.current_period_end,
      cancel_at_period_end = EXCLUDED.cancel_at_period_end,
      updated_at = now()`;
  return row;
}

type SubscriptionRow = {
  user_id: string;
  stripe_customer_id: string;
  stripe_subscription_id: string;
  tier: string;
  status: string;
  current_period_start: Date;
  current_period_end: Date;
  cancel_at_period_end: boolean;
};

export async function readSubscription(
  sql: Sql,
  userId: string,
): Promise<SeededSubscriptionRow | null> {
  await assertSubscriptionsTable(sql);
  const rows = await sql<SubscriptionRow[]>`
    SELECT user_id, stripe_customer_id, stripe_subscription_id, tier, status,
      current_period_start, current_period_end, cancel_at_period_end
    FROM subscriptions WHERE user_id = ${userId}`;
  const found = rows[0];
  if (!found) return null;
  return {
    userId: found.user_id,
    stripeCustomerId: found.stripe_customer_id,
    stripeSubscriptionId: found.stripe_subscription_id,
    tier: found.tier,
    status: found.status,
    currentPeriodStart: found.current_period_start,
    currentPeriodEnd: found.current_period_end,
    cancelAtPeriodEnd: found.cancel_at_period_end,
  };
}

// Later slices call this to start from entitlement-off: no row means no
// entitlement, whatever users.member says. Deletes the row rather than marking
// canceled so the off state is unambiguous in every downstream slice.
export async function ensureEntitlementOff(sql: Sql, userId: string): Promise<void> {
  await assertSubscriptionsTable(sql);
  await sql`DELETE FROM subscriptions WHERE user_id = ${userId}`;
}
