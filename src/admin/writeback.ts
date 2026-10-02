// Event write-back dispatch seam (W11 → W8).
//
// Publish/cancel (and edits to mirrored rows) reach the Discord bot through
// the event-sync queue (src/events/sync.ts). Routes call this after a
// successful store transition; `vitest` `vi.mock`s this module to pin the
// dispatch at the route level.

import type { Env } from "../env";
import { enqueueEventSync } from "../events/sync";
import type { WriteBack } from "./store";

export async function dispatchWriteBack(
  env: Env,
  wb: NonNullable<WriteBack>,
  requestId?: string,
): Promise<void> {
  await enqueueEventSync(env, wb.eventKey, wb.status, requestId);
}
