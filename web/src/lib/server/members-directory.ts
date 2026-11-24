import type { AccessSink } from "../../../../src/access-log";
import type { KitRequestSession } from "../../../../src/kit-session";
import {
  declareMemberResult,
  memberReadResponse,
  refuseMemberRead,
} from "../../../../src/member-reads";
import { SNOWFLAKE } from "../../../../src/profiles/routes-shared";

export const DIRECTORY_ROW_LIMIT = 20;
export const DIRECTORY_READ_TIMEOUT_MS = 500;
const DISPLAY_NAME_LIMIT = 128;
const AUDIT_ROUTE = "members.directory";

export type DirectoryCandidate = {
  id: string;
  name: string;
  currentMember: boolean;
  // A future source needs explicit directory eligibility. Profile-by-ID
  // access and the leaderboard switch grant no directory eligibility.
  visibility: "listed" | "hidden";
};

export type DirectoryRow = Pick<DirectoryCandidate, "name"> & { profileHref: string };

// An authorized adapter must apply membership and visibility before its
// storage-side limit and enforce a storage-side deadline as well as abort.
export type DirectorySource = (options: {
  viewerId: string;
  limit: number;
  signal: AbortSignal;
}) => Promise<readonly DirectoryCandidate[]>;

async function readDirectory(source: DirectorySource, viewerId: string) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error("Member directory read timed out."));
      controller.abort();
    }, DIRECTORY_READ_TIMEOUT_MS);
  });
  try {
    return await Promise.race([
      source({ viewerId, limit: DIRECTORY_ROW_LIMIT, signal: controller.signal }),
      deadline,
    ]);
  } catch {
    refuseMemberRead();
  } finally {
    clearTimeout(timer);
  }
}

/** Dormant member-only page boundary. Only the Kit session bridge supplies the viewer. */
export async function memberDirectoryResponse({
  session,
  source,
  writeAudit,
  render,
}: {
  session: KitRequestSession;
  source?: DirectorySource;
  writeAudit?: AccessSink;
  render: (rows: DirectoryRow[]) => Response | Promise<Response>;
}): Promise<Response> {
  const refuse = (status: number) =>
    new Response(null, { status, headers: { "cache-control": "private, no-store" } });
  if (session.status === "unknown") return refuse(503);
  if (session.status !== "authenticated" || !session.session) return refuse(401);
  const { userId, member } = session.session;
  if (member !== true) return refuse(403);
  if (typeof userId !== "string" || !SNOWFLAKE.test(userId) || !source || !writeAudit)
    return refuse(503);

  return memberReadResponse(
    { method: "GET", route: AUDIT_ROUTE },
    { viewer: userId, resource: "member-directory", action: "list", route: AUDIT_ROUTE },
    writeAudit,
    async () => {
      const candidates = await readDirectory(source, userId);
      if (!Array.isArray(candidates) || candidates.length > DIRECTORY_ROW_LIMIT) refuseMemberRead();
      const subjects = new Set<string>();
      const rows: DirectoryRow[] = [];
      for (const candidate of candidates) {
        const id = candidate?.id;
        if (typeof id !== "string" || !SNOWFLAKE.test(id) || subjects.has(id)) refuseMemberRead();
        subjects.add(id);
        if (candidate.currentMember !== true || candidate.visibility !== "listed") continue;
        const { name } = candidate;
        if (typeof name !== "string" || name.length > DISPLAY_NAME_LIMIT || !name.trim())
          refuseMemberRead();
        rows.push({ name, profileHref: `/members/${id}` });
      }
      // Audit all fetched owners, including rows withheld from the view.
      declareMemberResult([...subjects]);
      return render(rows);
    },
  );
}
