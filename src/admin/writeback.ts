// Event write-back dispatch seam (W11).
//
// Publish/cancel (and edits to mirrored rows) must reach the Discord bot.
// The queue that carries them lands with W8; until then this seam logs the
// due write-back so a transition without a carrier is visible, never silent.
// Routes call it synchronously after a successful store transition —
// `vitest` `vi.mock`s this module to pin the dispatch at the route level.

import type { Env } from "../env";
import type { WriteBack } from "./store";

export function dispatchWriteBack(_env: Env, wb: NonNullable<WriteBack>): void {
  console.info("event write-back due", { eventKey: wb.eventKey, status: wb.status });
}
