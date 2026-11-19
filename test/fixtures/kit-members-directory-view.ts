import type { MembersDirectoryView } from "../../web/src/lib/members-directory";

const name = "Sample Comet";
const counts = { members: 814, attendedThisMonth: 212 };
export const guest = { audience: "guest", counts } satisfies MembersDirectoryView;
export const directory = {
  audience: "member",
  counts,
  selection: { filter: "active", query: "", page: 1 },
  filterCounts: { active: 1, everyone: 1, guides: 1 },
  resultCount: 1,
  pageCount: 1,
  rows: [
    {
      name,
      rank: 3,
      profileHref: "/members/sample-comet",
      role: "Guide",
      lastSeen: "Synthetic race · 2 d ago",
      games: ["Example Racing"],
    },
  ],
  newcomers: [{ name, day: "Today", sayHiHref: "/welcome/sample-comet" }],
  organizers: [{ name, role: "Event host" }],
} satisfies MembersDirectoryView;

type Filter = keyof typeof directory.filterCounts;
export function emptyDirectory(filter: Filter, query = "", everyone = 1): MembersDirectoryView {
  return {
    ...directory,
    selection: { filter, query, page: 1 },
    filterCounts: { active: 0, everyone, guides: 0 },
    resultCount: 0,
    rows: [],
    newcomers: [],
    organizers: [],
  };
}
