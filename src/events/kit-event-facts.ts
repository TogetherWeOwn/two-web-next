export interface KitEventFact {
  key: "Host" | "Game";
  value: string;
}

/** Kit C6 facts list (two-design-kit v0.3.1). Only the standard keys that the
 * model backs with real, public data render, in kit order. Room, Repeats and
 * Talk have no source field (venue is not a Discord room; there is no cadence
 * or thread), and Share stays on the shared share leaf, so none is invented
 * or duplicated here. Empty list means the view renders no box. */
export function kitEventFacts(model: {
  organizerName: string | null;
  game: string | null;
}): KitEventFact[] {
  const facts: KitEventFact[] = [];
  const host = model.organizerName?.trim();
  if (host) facts.push({ key: "Host", value: host });
  const game = model.game?.trim();
  if (game) facts.push({ key: "Game", value: game });
  return facts;
}
