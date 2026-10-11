// Admin write-back refusal (nightly mutation A2): pins
// src/admin/writeback.ts's dispatch through the real enqueue seam.
//
// A forced dispatch (e.g. `wb.status` mutated to `"published"`) must be killed
// here: mirrored statuses (published/cancelled) dispatch, while a refused
// status (draft) stays suppressed. A dropped dispatch (no enqueue at all) is
// killed by the same file: the published case would go silent.
//
// Hermetic and DB-free: unbound SYNC_EVENT_QUEUE only, no DATABASE_URL, no
// Discord, no database. The unbound carrier warns and returns the built
// message without touching the queue transport, so the warn spy is the
// dispatch signal. Matches the sessions-join nightly contract exactly.
//
// Scope guard: must not mock `src/events/sync.ts`; the seam stays real so a
// writeback mutant changes the observed warn/no-warn signal.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { dispatchWriteBack } from "../src/admin/writeback";

const env = { APP_URL: "https://next.example.test" } as Env;
// Plainly synthetic fixture key (not ULID-shaped): the dispatch seam treats
// eventKey as opaque, and a low-entropy value keeps the secret scanner quiet
// without needing an allowlist entry.
const KEY = "evt-test-refusal-001";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("admin write-back refusal dispatch (dispatch seam, no DB)", () => {
  it("dispatches mirrored statuses and suppresses a refused draft", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await dispatchWriteBack(env, { eventKey: KEY, status: "published" });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0] ?? "")).toContain("SYNC_EVENT_QUEUE");

    warn.mockClear();
    await dispatchWriteBack(env, { eventKey: KEY, status: "cancelled" });
    expect(warn).toHaveBeenCalledTimes(1);

    warn.mockClear();
    await dispatchWriteBack(env, { eventKey: KEY, status: "draft" });
    expect(warn).not.toHaveBeenCalled();
  });
});
