import { vi } from "vitest";
import type { pgReconciliationStore } from "../../src/jobs/reconciliation";

type Store = ReturnType<typeof pgReconciliationStore>;

export function announcementStore(attempts = 1, now: () => Date = () => new Date()) {
  return {
    claimAnnouncement: vi.fn<Store["claimAnnouncement"]>(async () => ({
      kind: "claimed",
      attempts,
      claimUntil: new Date(now().getTime() + 30_000),
    })),
    finishAnnouncement: vi.fn<Store["finishAnnouncement"]>().mockResolvedValue(true),
    recordAnnouncement: vi.fn<Store["recordAnnouncement"]>().mockResolvedValue(undefined),
  };
}
