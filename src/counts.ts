// Landing-page counts seam (W4). Ports the two-web CountsSource contract
// (app/Support/Counts): the page is handed counts that may be absent and
// renders correctly either way — a bot-DB outage degrades to the designed
// empty state, never a 500.
//
// W4 has no database binding yet, so this always answers "unavailable" (the
// degraded path, pinned by tests). The data slices wire the Hyperdrive→Neon
// read of the bot's web_v1 views here; nothing in the page changes when they
// do. Reads must never throw: like CountsReader, any failure degrades and
// gets logged, it never breaks the funnel top.
import type { Env } from "./env";

export type Counts = {
  memberCount: number | null;
  onlineCount: number | null;
};

export const UNAVAILABLE: Counts = { memberCount: null, onlineCount: null };

export async function readCounts(_env: Env): Promise<Counts> {
  return UNAVAILABLE;
}
