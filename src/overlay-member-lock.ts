// Overlay writers and member erasure share one transaction-scoped fence.
// Lock before reading/writing any overlay rows, then issue the mutation as a
// separate statement: READ COMMITTED must take its snapshot AFTER the wait.
// Unlike row locks or a recount loop this also fences a member's first mint
// (there may be no visible token/config row to lock yet). Future config writers
// must use the same fence. Different members need not block one another.
export type OverlayMemberTx = <T = Record<string, unknown>[]>(
  strings: TemplateStringsArray,
  ...values: unknown[]
) => Promise<T>;

export type OverlayMemberSql = OverlayMemberTx & {
  begin: <T>(fn: (tx: OverlayMemberTx) => Promise<T>) => Promise<T>;
};

export async function lockOverlayMember(tx: OverlayMemberTx, memberId: string): Promise<void> {
  await tx`select pg_advisory_xact_lock(hashtextextended('two:overlay:' || ${memberId}, 0))`;
}
