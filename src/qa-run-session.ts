import { QA_IDENTITIES, qaIdentity } from "./qa";
import {
  type QaRunClock,
  type QaRunContext,
  qaRunContext,
  qaRunNamespaceMatches,
} from "./qa-run-auth";
import { type DbSessionRow, hashToken, type SessionStore } from "./sessions";

export type QaRunSessionRequest = {
  binding: unknown;
  requestUrl: string;
  appUrl: string;
  clock?: QaRunClock;
};

export type QaRunSessionGrant = {
  token: string;
  row: DbSessionRow;
  expiresAt: Date;
  cookieTtlSeconds: number;
};

function fixtureRow(row: DbSessionRow | null): row is DbSessionRow {
  return (
    row !== null &&
    row.member === true &&
    Object.values(QA_IDENTITIES).some(
      (identity) =>
        row.userId === identity.discordId &&
        row.username === identity.username &&
        row.avatar === null &&
        row.moderator === identity.moderator,
    )
  );
}

function newToken(q: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const nonce = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `q1s.${q}.${nonce}`;
}

// No signing key and no ordinary-session fallback. Route adapters must use this
// boundary for the complete read/write closure before qualification is enabled.
export function createQaRunSessionBoundary(store: SessionStore, request: QaRunSessionRequest) {
  const active = () =>
    qaRunContext(request.binding, request.requestUrl, request.appUrl, request.clock);
  const sameRun = (context: QaRunContext | null, q: string): context is QaRunContext =>
    context !== null && context.verifier.q === q;
  const grant = (token: string, row: DbSessionRow, context: QaRunContext): QaRunSessionGrant => ({
    token,
    row,
    expiresAt: new Date(context.deadline * 1000),
    cookieTtlSeconds: Math.max(0, Math.floor(context.deadline - context.now)),
  });

  const admitToken = async (token: string) => {
    const context = await active();
    if (!context || !qaRunNamespaceMatches(token, "session", context.verifier.q)) return null;
    const tokenHash = await hashToken(token);
    const current = await active();
    return sameRun(current, context.verifier.q) ? { context: current, tokenHash } : null;
  };

  return {
    async read(token: string): Promise<DbSessionRow | null> {
      const admitted = await admitToken(token);
      if (!admitted) return null;
      const { context, tokenHash } = admitted;
      const row = await store.get(tokenHash);
      return fixtureRow(row) && sameRun(await active(), context.verifier.q) ? row : null;
    },

    async issue(identityName: string, previous = ""): Promise<QaRunSessionGrant | null> {
      const context = await active();
      const identity = qaIdentity(identityName);
      if (!context || !identity) return null;
      const token = newToken(context.verifier.q);
      const row: DbSessionRow = {
        userId: identity.discordId,
        username: identity.username,
        avatar: null,
        member: true,
        moderator: identity.moderator,
      };
      const tokenHash = await hashToken(token);
      const replacement = {
        ...row,
        tokenHash,
        // Persist the public run namespace in the existing liveness field.
        // Stripping q before lookup would let an old status suffix be relabeled.
        statusHash: `q1p.${context.verifier.q}.${tokenHash}`,
        expiresAt: new Date(context.deadline * 1000),
      };
      const priorHash = qaRunNamespaceMatches(previous, "session", context.verifier.q)
        ? await hashToken(previous)
        : null;
      if (!sameRun(await active(), context.verifier.q)) return null;
      if (priorHash) await store.replace(priorHash, replacement);
      else await store.create(replacement);
      await store.revokeUserSessions(row.userId, replacement.tokenHash);
      const current = await active();
      return sameRun(current, context.verifier.q) ? grant(token, row, current) : null;
    },

    async rotate(token: string): Promise<QaRunSessionGrant | null> {
      const admitted = await admitToken(token);
      if (!admitted) return null;
      const { context, tokenHash: oldHash } = admitted;
      const row = await store.get(oldHash);
      if (!fixtureRow(row) || !sameRun(await active(), context.verifier.q)) return null;
      const successor = newToken(context.verifier.q);
      const successorHash = await hashToken(successor);
      if (!sameRun(await active(), context.verifier.q)) return null;
      const rotated = await store.rotate(oldHash, {
        ...row,
        tokenHash: successorHash,
        expiresAt: new Date(context.deadline * 1000),
      });
      if (!rotated || !sameRun(await active(), context.verifier.q)) return null;
      // Rotation may race a demotion. The store is least-privilege authority;
      // never return the caller's pre-rotation snapshot as the successor row.
      const actual = await store.get(successorHash);
      const current = await active();
      return fixtureRow(actual) && sameRun(current, context.verifier.q)
        ? grant(successor, actual, current)
        : null;
    },

    async renew(token: string): Promise<boolean> {
      const admitted = await admitToken(token);
      if (!admitted) return false;
      const { context, tokenHash } = admitted;
      if (!fixtureRow(await store.get(tokenHash)) || !sameRun(await active(), context.verifier.q))
        return false;
      const renewed = await store.renew(tokenHash, new Date(context.deadline * 1000));
      return renewed && sameRun(await active(), context.verifier.q);
    },

    async status(token: string): Promise<string | null> {
      const admitted = await admitToken(token);
      if (!admitted) return null;
      const { context, tokenHash } = admitted;
      if (!fixtureRow(await store.get(tokenHash)) || !sameRun(await active(), context.verifier.q))
        return null;
      const status = await store.statusHash(tokenHash);
      return status &&
        qaRunNamespaceMatches(status, "status", context.verifier.q) &&
        sameRun(await active(), context.verifier.q)
        ? status
        : null;
    },

    async isActive(status: string): Promise<boolean> {
      const context = await active();
      if (!context || !qaRunNamespaceMatches(status, "status", context.verifier.q)) return false;
      const alive = await store.isActive(status);
      return alive && sameRun(await active(), context.verifier.q);
    },

    async revoke(token: string, everywhere = false): Promise<boolean> {
      const admitted = await admitToken(token);
      if (!admitted) return false;
      const { context, tokenHash } = admitted;
      const row = await store.get(tokenHash);
      if (!fixtureRow(row) || !sameRun(await active(), context.verifier.q)) return false;
      if (everywhere) await store.revokeUserSessions(row.userId, "");
      else {
        const status = await store.statusHash(tokenHash);
        if (status) await store.revokeLineage(status);
        // A valid grace predecessor has no primary statusHash. Fresh fixture
        // login revokes every older lineage, so sweep that fixture user rather
        // than revoking just the predecessor and leaving its successor live.
        else await store.revokeUserSessions(row.userId, "");
      }
      return true;
    },
  };
}
