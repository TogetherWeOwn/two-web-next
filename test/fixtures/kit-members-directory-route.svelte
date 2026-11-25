<script lang="ts">
import { page } from "$app/state";
import MembersDirectory from "#lib/MembersDirectory.svelte";
import SiteMetadata from "#lib/SiteMetadata.svelte";
import {
  type DirectoryFixtureMember,
  type MembersDirectoryView,
  projectMembersDirectory,
} from "#lib/members-directory";

let { data }: { data: { serverDirectory?: MembersDirectoryView } } = $props();

// Synthetic data only. Links are never followed and no avatars are loaded.
const WEEK = 1_000;
const NOW = 2_000;
const base = (n: number, extra: Partial<DirectoryFixtureMember> = {}): DirectoryFixtureMember => ({
  name: `Fixture Member ${n}`,
  handle: `fixture_handle_${n}`,
  profileHref: `/members/fixture-${n}`,
  rank: ((n % 5) + 1) as 1 | 2 | 3 | 4 | 5,
  games: ["Synthetic Chess", "Synthetic Cards"],
  lastSeen: "this week",
  active: true,
  lastActivityAt: NOW - n,
  ...extra,
});
const newcomer = (n: number): Partial<DirectoryFixtureMember> => ({
  welcome: { joinedAt: WEEK + 10 + n, day: "Tuesday", sayHiHref: `/welcome/fixture-${n}` },
});
const roster = (welcome: boolean): DirectoryFixtureMember[] => [
  ...Array.from({ length: 6 }, (_, i) => base(i + 1, welcome ? newcomer(i) : {})),
  base(7, { role: "Guide", organizerRole: "Event host" }),
  base(8, {
    name: "Quiet Inactive Fixture",
    handle: "quiet_inactive",
    active: false,
    lastActivityAt: undefined,
  }),
  base(9, {
    name: "Hidden Opt Out Alias",
    handle: "hidden_opt_out",
    optedOut: true,
    organizerRole: "Fixture moderator",
    ...(welcome ? newcomer(9) : {}),
  }),
];
const many = Array.from({ length: 45 }, (_, i) => base(i + 1, i === 0 ? { role: "Guide" } : {}));
const noOptOut = roster(true).map((member) => ({ ...member, optedOut: false }));
const scenarios: Record<string, DirectoryFixtureMember[]> = {
  default: roster(true),
  nonew: roster(false),
  e1: [base(1, { optedOut: true })],
  e2: [base(1, { active: false }), base(2, { active: false })],
  e3: [base(1), base(2)],
  many,
  nooptout: noOptOut,
};

const state = $derived(page.url.searchParams.get("state") ?? undefined);
const input = $derived(
  state === "guest"
    ? ({ audience: "guest", counts: { members: 814, attendedThisMonth: 212 } } as const)
    : ({
        audience: "member",
        counts: { members: 814, attendedThisMonth: 212 },
        members: scenarios[state ?? "default"] ?? scenarios.default,
        weekStartsAt: WEEK,
        snapshotAt: NOW,
      } as const),
);
const _directory = $derived.by(() => {
  if (state === "server-contract") {
    if (!data?.serverDirectory) throw new Error("Synthetic server directory view is required");
    return data.serverDirectory;
  }
  return projectMembersDirectory(input, page.url.searchParams);
});
</script>

<SiteMetadata title="Members" theme="home" />
<MembersDirectory directory={_directory} action="/__browser_fixture__" helpHref="/welcome/help" fixtureState={state} />
