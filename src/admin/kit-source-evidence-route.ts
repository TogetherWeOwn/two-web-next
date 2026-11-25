import { SOURCE_EVIDENCE_REFUSED_METHODS } from "./source-evidence";

export const KIT_SOURCE_EVIDENCE_ROUTES = ["GET", ...SOURCE_EVIDENCE_REFUSED_METHODS].map(
  (method) =>
    ({
      method,
      path: "/admin/queue/source-evidence/:id",
      enabled: true,
      // The verifier owns bearer admission and never reads a moderator session.
      reads: "public",
      dynamic: {
        id: "/admin/queue/source-evidence/[id]",
        matches: (raw: string) => /^\/admin\/queue\/source-evidence\/[^/%]+$/.test(raw),
      },
    }) as const,
);
