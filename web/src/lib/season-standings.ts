import type { PublicEcho } from "../../../src/events/echo-public";
import type { loadMembersBoardData } from "../../../src/kit-members";

type Board = Awaited<ReturnType<typeof loadMembersBoardData>>;

export type SignupSeasonBoard = Board & {
  activityInput?: string;
  restoredWrite?: boolean;
  echo?: never;
};

// An event Echo supplies the source label. The standings producer supplies
// ranked, privacy-filtered rows of per-member event counts separately.
export type FrozenSeasonStandings = Pick<Board, "season" | "viewerUsername" | "appUrl"> & {
  echo: Pick<PublicEcho, "label">;
  result:
    | {
        status: "ready";
        rows: Readonly<Board["rows"]>;
        viewer: "ranked" | "opted-out" | "zero";
      }
    | { status: "unavailable" };
};
