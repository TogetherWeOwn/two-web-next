import { projectMembersDirectory } from "#lib/members-directory";
import { memberDirectoryResponse } from "#lib/server/members-directory";

// Installed only in the scratch fixture route. These are synthetic identities.
const viewerId = "9000000001";
const listed = {
  id: "9000000002",
  name: "Listed Server Fixture",
  currentMember: true,
  visibility: "listed",
  bio: "directory-private-canary",
};
const hidden = { ...listed, id: "9000000003", name: "Hidden Server Fixture", visibility: "hidden" };

export async function load({ url, setHeaders }) {
  if (url.searchParams.get("state") !== "server-contract") return {};
  const response = await memberDirectoryResponse({
    session: {
      status: "authenticated",
      session: {
        userId: viewerId,
        member: true,
        moderator: false,
        username: "Fixture",
        avatar: null,
      },
    },
    source: async () => [listed, hidden],
    writeAudit: async ({ viewerUserId, subjectUserIds }) =>
      viewerUserId === viewerId && subjectUserIds.join(",") === `${listed.id},${hidden.id}`,
    render: (rows) => Response.json(rows),
  });
  if (!response.ok) throw new Error("Synthetic directory audit refused the view");
  setHeaders({ "cache-control": response.headers.get("cache-control") });
  const rows = await response.json();
  return {
    serverDirectory: projectMembersDirectory(
      {
        audience: "member",
        counts: { members: rows.length, attendedThisMonth: 0 },
        // Activity and rank are required presentation values for this fixture only.
        members: rows.map((row) => ({ ...row, handle: "", rank: 1, games: [], active: true })),
        weekStartsAt: 1_000,
        snapshotAt: 2_000,
      },
      url.searchParams,
    ),
  };
}
