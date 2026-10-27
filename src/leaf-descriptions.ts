// Share descriptions for the four public information leaves, shared by the
// Hono leaves (src/page-shell.tsx) and the Kit pages (web/src/routes/*).
// Pure static data with no runtime inputs. Each sentence restates
// what the linked page already says and nothing more: no legal, privacy or
// search-performance claim. Change a sentence here once and both renderers
// follow.

export const LEAF_DESCRIPTIONS = {
  "/about":
    "About Together We Own: an adult gaming community since 1998, now open for newcomers to turn up and say hello.",
  "/faq":
    "Newcomer FAQ: joining, first week, ranks, events, game picker, tickets, profiles and conduct.",
  "/rules":
    "House rules: 18+ only, Respect the room, Voice-first, Play fair & Moderators have the last word.",
  "/privacy":
    "Privacy policy: what the website stores, who can see it, and how to ask for deletion.",
} as const;

export type LeafDescriptionPath = keyof typeof LEAF_DESCRIPTIONS;

export const leafDescription = (path: string): string | undefined =>
  Object.hasOwn(LEAF_DESCRIPTIONS, path)
    ? LEAF_DESCRIPTIONS[path as LeafDescriptionPath]
    : undefined;
