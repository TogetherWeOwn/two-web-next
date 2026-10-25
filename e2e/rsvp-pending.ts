import { expect, type Page, type Response } from "@playwright/test";
import {
  RSVP_SYNCED_TESTID,
  RSVP_SYNCING_COPY,
  RSVP_SYNCING_TESTID,
} from "../src/islands/contracts";

export async function assertFreshPendingRsvp(page: Page, response: Response): Promise<void> {
  expect(response.status()).toBe(201);
  const { data } = (await response.json()) as {
    data: { status: string; synced_to_discord_at: string | null };
  };
  expect(data.status).toBe("going");
  expect(data.synced_to_discord_at).toBeNull();

  const pending = page.getByTestId(RSVP_SYNCING_TESTID);
  await expect.soft(pending).toBeVisible();
  await expect.soft(pending).toHaveText(RSVP_SYNCING_COPY);
  await expect.soft(page.getByTestId(RSVP_SYNCED_TESTID)).toHaveCount(0);
}

export async function assertNoRsvpSyncNotes(page: Page): Promise<void> {
  await expect(page.getByTestId(RSVP_SYNCING_TESTID)).toHaveCount(0);
  await expect(page.getByTestId(RSVP_SYNCED_TESTID)).toHaveCount(0);
}
