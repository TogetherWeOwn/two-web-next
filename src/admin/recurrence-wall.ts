import { utcToWall, wallToUtc } from "./validation";

// Keep Date precision separate from the minute-only form text. Resolve the
// minute's fold/gap policy first, then restore the seed's seconds/milliseconds.
export type PreciseWall = { minute: string; subMinuteMs: number };

export function utcToPreciseWall(instant: Date, timezone: string): PreciseWall {
  return {
    minute: utcToWall(instant, timezone),
    subMinuteMs: instant.getUTCSeconds() * 1000 + instant.getUTCMilliseconds(),
  };
}

export function preciseWallToUtc(wall: PreciseWall, timezone: string): Date {
  const minute = wallToUtc(wall.minute, timezone);
  return new Date(minute.getTime() + wall.subMinuteMs);
}
