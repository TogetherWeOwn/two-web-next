// House-rules content source, shared by the Hono leaf (src/screens/rules.tsx),
// the Markdown alternate (src/ai-friendly/md.ts) and the Kit page
// (web/src/routes/rules/). Pure data + the date-stamp mapping: no session, no
// cookie, no database — importing this module must never connect to anything.
import { rulesLastUpdated } from "./rules-last-updated";

export const RULES: Array<[title: string, body: string, id: string]> = [
  // Stable fragment ids, assigned once per rule: the jump index targets them
  // and moderators share `#rule-*` links. Never derived from the wording or
  // the position — acceptance renames and reorders rows while the ids stay
  // put — so a retitled or reordered rule keeps its address.
  [
    "18+ only",
    "Together We Own is an adult gaming community. If you are under 18, this is not your lobby yet.",
    "rule-adults-only",
  ],
  [
    "Respect the room",
    "No harassment, hate, or punching down. Argue about games all you like; never about people.",
    "rule-respect",
  ],
  [
    "Voice-first",
    "The community lives in voice. Turn up, say hello, and come back — that is the whole membership path.",
    "rule-voice",
  ],
  [
    "Play fair",
    "No cheating, exploits, or griefing. Do not spoil the game for the people you share it with.",
    "rule-fair-play",
  ],
  [
    "Moderators have the last word",
    "If a moderator asks you to stop, stop. Appeals happen in private, not in the lobby.",
    "rule-moderators",
  ],
];

export type RulesPageData = {
  appUrl: string;
  rules: typeof RULES;
  lastUpdated: ReturnType<typeof rulesLastUpdated>;
};

// The Kit load function only reorders the same reads as the Hono handler
// (src/static-leaves.tsx): APP_URL plus the config stamp, mapped through the
// shared validator so an empty or unparseable value hides the stamp. Kept here
// (not in the Kit route) so the root suite can pin it without importing
// SvelteKit or worker code.
export function rulesPageData(appUrl: string, raw: string | undefined): RulesPageData {
  return { appUrl, rules: RULES, lastUpdated: rulesLastUpdated(raw) };
}
