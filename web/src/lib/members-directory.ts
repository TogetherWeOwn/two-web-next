export const MEMBER_FILTERS = ["active", "everyone", "guides"] as const;
export const MEMBER_SEARCH_LIMIT = 80;
const PAGE_SIZE = 20;
const NEWCOMER_LIMIT = 6;
const ORGANIZER_LIMIT = 4;

type MemberFilter = (typeof MEMBER_FILTERS)[number];
type Counts = { members: number; attendedThisMonth: number };
type Identity = { name: string; avatarUrl?: string };
type MemberRow = Identity & {
  profileHref: string;
  rank: 1 | 2 | 3 | 4 | 5;
  games: readonly string[];
  lastSeen?: string;
  role?: "Moderator" | "Guide" | "Host";
};

// Synthetic inputs only. This module does not resolve sessions, authorize a
// member read, or define how production member data may be projected.
export type DirectoryFixtureMember = MemberRow & {
  handle: string;
  active: boolean;
  optedOut?: boolean;
  lastActivityAt?: number;
  organizerRole?: string;
  welcome?: { joinedAt: number; day: string; sayHiHref: string };
};

type FixtureInput =
  | { audience: "guest"; counts: Counts }
  | {
      audience: "member";
      counts: Counts;
      members: readonly DirectoryFixtureMember[];
      weekStartsAt: number;
      snapshotAt: number;
    };

type DirectorySelection = { filter: MemberFilter; query: string; page: number };

type MemberDirectoryView = {
  audience: "member";
  counts: Counts;
  selection: DirectorySelection;
  filterCounts: Record<MemberFilter, number>;
  resultCount: number;
  pageCount: number;
  rows: MemberRow[];
  newcomers: (Identity & { day: string; sayHiHref: string })[];
  organizers: (Identity & { role: string })[];
};

export type MembersDirectoryView = { audience: "guest"; counts: Counts } | MemberDirectoryView;

function selectDirectory(params: URLSearchParams): DirectorySelection {
  const filter = params.get("filter");
  const page = Number(params.get("page"));
  return {
    filter: filter === "everyone" || filter === "guides" ? filter : "active",
    query: (params.get("q") ?? "").trim().slice(0, MEMBER_SEARCH_LIMIT).trimEnd(),
    page: Number.isSafeInteger(page) && page > 0 ? page : 1,
  };
}

function searchable(text: string) {
  return text.normalize("NFKC").toLowerCase();
}

function identity({ name, avatarUrl }: Identity): Identity {
  return { name, avatarUrl };
}

function asRow(member: DirectoryFixtureMember): MemberRow {
  return {
    ...identity(member),
    profileHref: member.profileHref,
    rank: member.rank,
    games: member.games.slice(0, 2),
    lastSeen: member.lastSeen,
    role: member.role,
  };
}

export function projectMembersDirectory(
  input: FixtureInput,
  params: URLSearchParams,
): MembersDirectoryView {
  const { members, attendedThisMonth } = input.counts;
  const counts = { members, attendedThisMonth };
  if (input.audience === "guest") return { audience: "guest", counts };

  const selection = selectDirectory(params);
  const visible = input.members.filter((member) => !member.optedOut);
  const guides = visible.filter((member) => member.role === "Guide");
  const active = visible.filter((member) => member.active);
  const term = searchable(selection.query);
  const handleTerm = term.replace(/^@/, "");
  // Active is the default browse view, not a limit on who can be found by search.
  const browse = selection.filter === "active" && !term ? active : visible;
  const population = selection.filter === "guides" ? guides : browse;
  const results = term
    ? population.filter(
        (member) =>
          searchable(member.name).includes(term) ||
          (handleTerm !== "" && searchable(member.handle).includes(handleTerm)),
      )
    : [...population];
  results.sort(
    (a, b) =>
      (b.lastActivityAt ?? -Infinity) - (a.lastActivityAt ?? -Infinity) ||
      a.name.localeCompare(b.name, "en"),
  );

  const pageCount = Math.max(1, Math.ceil(results.length / PAGE_SIZE));
  selection.page = Math.min(selection.page, pageCount);
  const offset = (selection.page - 1) * PAGE_SIZE;
  const newcomers = visible
    .flatMap((member) => {
      if (!member.welcome) return [];
      const { joinedAt, day, sayHiHref } = member.welcome;
      if (joinedAt < input.weekStartsAt || joinedAt > input.snapshotAt) return [];
      return [{ ...identity(member), joinedAt, day, sayHiHref }];
    })
    .sort((a, b) => b.joinedAt - a.joinedAt)
    .slice(0, NEWCOMER_LIMIT)
    .map(({ name, avatarUrl, day, sayHiHref }) => ({ name, avatarUrl, day, sayHiHref }));

  return {
    audience: "member",
    counts,
    selection,
    filterCounts: { active: active.length, everyone: visible.length, guides: guides.length },
    resultCount: results.length,
    pageCount,
    rows: results.slice(offset, offset + PAGE_SIZE).map(asRow),
    newcomers,
    organizers: visible
      .flatMap((member) =>
        member.organizerRole ? [{ ...identity(member), role: member.organizerRole }] : [],
      )
      .slice(0, ORGANIZER_LIMIT),
  };
}
