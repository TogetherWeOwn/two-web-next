// A request owns its read receipts and its buffered response. A declaration
// never authorizes subsequent queries, and a caught refusal remains a refusal.
import { AsyncLocalStorage } from "node:async_hooks";
import type { Context, Next } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { AccessDecl, AccessSink } from "./access-log";
import { MEMBER_ACCESS_AUDIT_TIMEOUT_MS, withAccessAuditDeadline } from "./access-log";
import { alertRequestError } from "./alerts";
import { isDatabaseUnavailable } from "./db/errors";
import { requestRoute, safeRequestId } from "./request-log";

/**
 * Kit/Hono shared-boundary alias for the audit-wait deadline owned by
 * src/access-log.ts. A member read is released only after its audit row is
 * written; this bounds that wait. Timeout renders the existing sanitized
 * 503/private-no-store outage response, never the buffered member success
 * body or its sensitive headers. See MEMBER_ACCESS_AUDIT_TIMEOUT_MS for the
 * CISO rationale; the value is shared so Hono and Kit cannot diverge.
 */
export const MEMBER_READ_AUDIT_TIMEOUT_MS = MEMBER_ACCESS_AUDIT_TIMEOUT_MS;

type Capture = {
  subjects: Set<string>;
  failed: boolean;
  pending: number;
  response?: Response;
};
export type NonSensitiveRead =
  | "events"
  | "published-games"
  | "featured"
  | "activity-log"
  | "join-funnel"
  | "going-counts"
  | "roster-count"
  | "search-widget"
  | "timeouts";
type ReadPermit = { capture: Capture; queries: number; classification?: NonSensitiveRead };
const captures = new AsyncLocalStorage<Capture>();
const permits = new AsyncLocalStorage<ReadPermit>();

const READ_REFUSAL = "Member data is temporarily unavailable.";

export class MemberReadRefused extends Error {
  constructor() {
    super("Member read contract refused.");
  }
}

export function refuseMemberRead(): never {
  const capture = captures.getStore();
  if (capture) capture.failed = true;
  throw new MemberReadRefused();
}

/** Only one observed query can consume this permit, including nested reads. */
export function keyedMemberRead<T>(read: () => PromiseLike<T>): Promise<T> {
  return permittedRead(read);
}

/** The DB adapter checks this classification; it is not a blanket exemption. */
export function nonSensitiveRead<T>(
  classification: NonSensitiveRead,
  read: () => PromiseLike<T>,
): Promise<T> {
  return permittedRead(read, classification);
}

async function permittedRead<T>(
  read: () => PromiseLike<T>,
  classification?: NonSensitiveRead,
): Promise<T> {
  const capture = captures.getStore();
  if (!capture) return read();
  capture.pending++;
  try {
    const permit: ReadPermit = { capture, queries: 0, classification };
    // Drizzle builders are lazy thenables: consume them inside the permit.
    const result = await permits.run(permit, async () => await read());
    if (permit.queries !== 1) refuseMemberRead();
    return result;
  } finally {
    capture.pending--;
  }
}

/** The DB adapter calls this BEFORE executing a statement, not at declaration. */
export function memberQueryPermit(): ReadPermit | undefined {
  const capture = captures.getStore();
  if (!capture) return undefined;
  const permit = permits.getStore();
  if (!permit || permit.capture !== capture || ++permit.queries !== 1) refuseMemberRead();
  return permit;
}

export function memberReadActive(): boolean {
  return captures.getStore() !== undefined;
}

/** Non-SQL stores must declare the actual returned owners, including empty reads. */
export function declareMemberResult(keys: unknown[]): void {
  const capture = captures.getStore();
  if (capture) captureMemberKeys(capture, keys);
}

/** Keys come from retrieved owner columns, never from a route parameter. */
export function captureMemberKeys(capture: Capture, keys: unknown[]) {
  if (keys.some((key) => typeof key !== "string" || !/^\d{10,25}$/.test(key))) refuseMemberRead();
  for (const key of keys) capture.subjects.add(key as string);
}

/** HTML rendering finishes inside the boundary, never as a streamed response. */
export async function bufferedMemberHtml(
  c: Context,
  body: string | Promise<string>,
  status: ContentfulStatusCode = 200,
): Promise<Response> {
  const html = await body;
  // Hono JSX nodes are escaped HTML values with a buffered toString renderer.
  const escaped = html as unknown as { isEscaped?: boolean; toString?: unknown } | null;
  if (
    typeof html !== "string" &&
    !(escaped?.isEscaped === true && typeof escaped.toString === "function")
  )
    refuseMemberRead();
  c.res = await c.html(html, status);
  const capture = captures.getStore();
  if (capture) capture.response = c.res;
  return c.res;
}

/** Construct only known buffered bytes. Ordinary Response.body is a stream too. */
export function bufferedMemberText(
  c: Context,
  body: string,
  status: ContentfulStatusCode = 200,
): Response {
  if (typeof body !== "string") refuseMemberRead();
  const response = c.text(body, status);
  c.res = response;
  const capture = captures.getStore();
  if (capture) capture.response = c.res;
  return c.res;
}

/** JSON, like HTML/text, must be fully buffered before the audit boundary releases it. */
export function bufferedMemberJson(
  c: Context,
  body: unknown,
  status: ContentfulStatusCode = 200,
): Response {
  const response = c.json(body, status);
  c.res = response;
  const capture = captures.getStore();
  if (capture) capture.response = c.res;
  return c.res;
}

export type ReadDeclaration = Omit<AccessDecl, "subjects"> & { viewer: string | null };
export type MemberRead = Omit<ReadDeclaration, "viewer">;
export type MemberReadMeta = { method: string; route: string; requestId?: string };

/** Renders the caller's sanitized outage envelope (branded HTML or negotiated JSON). */
export type UnavailableResponse = (c: Context) => Response | Promise<Response>;

// Refused contents never leave the boundary. A classified outage or a failed
// audit write renders the caller's outage envelope; any other refusal stays
// the plain contract refusal, so a programming error is never relabelled as
// a database outage. Either way the reason is never in the body.
async function refuse(c: Context, unavailable?: UnavailableResponse): Promise<void> {
  c.res = unavailable ? await unavailable(c) : c.text(READ_REFUSAL, 503);
  c.header("cache-control", "private, no-store");
}

type Release = { released: true } | { released: false; outage: boolean };

// The one audit decision both renderers share. A read is released only when
// every query was permitted and classified, nothing is still pending, the
// declaration names a valid viewer, and the audit row (if any subject) was written.
async function releaseAfterAudit(
  capture: Capture,
  declared: ReadDeclaration | undefined,
  write: AccessSink,
  meta: MemberReadMeta,
): Promise<Release> {
  // Anonymous event pages may return explicitly classified public data only.
  // null is deliberate; missing/invalid viewers never authorize member data.
  if (
    !declared ||
    (declared.viewer === null ? capture.subjects.size > 0 : !/^\d{10,25}$/.test(declared.viewer))
  )
    capture.failed = true;
  if (capture.failed || capture.pending !== 0) return { released: false, outage: false };
  const subjects = [...capture.subjects].filter((key) => key !== declared!.viewer).sort();
  if (subjects.length === 0) return { released: true };
  try {
    // Bounded wait: a never-settling audit refuses with the sanitized
    // 503/private-no-store outage response. The sink runs exactly once; a late
    // success/rejection after the deadline is consumed by
    // withAccessAuditDeadline and cannot alter the response, replay the write,
    // or escape unhandled. This bounds liveness only: it does not cancel
    // database work (a late INSERT may still commit server-side, see
    // src/admin/store-access.ts), and audit failure still fails closed.
    const recorded = await withAccessAuditDeadline(
      captures.exit(() =>
        write({
          viewerDiscordId: declared!.viewer!,
          viewerUserId: declared!.viewer!,
          resource: declared!.resource,
          action: declared!.action,
          route: declared!.route,
          subjectUserIds: subjects,
        }),
      ),
    );
    if (!recorded) throw new MemberReadRefused();
    return { released: true };
  } catch (error) {
    alertRequestError(error, meta);
    // No SQL, parameters, route URL, subject keys or exception messages.
    console.error("Member read audit failed; refusing contents.", {
      exception: error instanceof Error ? error.constructor.name : "unknown",
      request_id: safeRequestId(meta.requestId),
    });
    // The audit store is unavailable for this read: an outage, not a contract bug.
    return { released: false, outage: true };
  }
}

function metaOf(c: Context): MemberReadMeta {
  return { method: c.req.method, route: requestRoute(c), requestId: c.get("requestId") };
}

export async function memberReadBoundary(
  c: Context,
  declaration: ReadDeclaration | (() => ReadDeclaration | undefined),
  write: AccessSink,
  next: Next,
  unavailable?: UnavailableResponse,
): Promise<void> {
  const capture: Capture = { subjects: new Set(), failed: false, pending: 0 };
  await captures.run(capture, async () => {
    let thrown: unknown;
    let didThrow = false;
    try {
      await next();
    } catch (error) {
      thrown = error;
      didThrow = true;
      capture.failed = true;
    }
    const meta = metaOf(c);
    if (didThrow && !c.error) alertRequestError(thrown, meta);
    if (c.error) capture.failed = true;
    const outage = isDatabaseUnavailable(thrown ?? c.error);
    const declared = typeof declaration === "function" ? declaration() : declaration;
    // Classification is tied to this exact response. A later stream (declared
    // or not) cannot borrow an earlier buffered response's approval.
    if (capture.response !== c.res) capture.failed = true;
    // Hono header() clones a finalized Response; classify before changing it.
    c.header("cache-control", "private, no-store");
    const release = await releaseAfterAudit(capture, declared, write, meta);
    if (!release.released) await refuse(c, outage || release.outage ? unavailable : undefined);
  });
}

/** A fully read copy this boundary owns: the only bytes a Kit render can release. */
async function bufferedCopy(response: Response): Promise<Response> {
  const bytes = await response.arrayBuffer();
  return new Response(bytes.byteLength === 0 ? null : bytes, {
    status: response.status,
    statusText: response.statusText,
    headers: new Headers(response.headers),
  });
}

function refusedResponse(): Response {
  return new Response(READ_REFUSAL, {
    status: 503,
    headers: { "content-type": "text/plain; charset=UTF-8", "cache-control": "private, no-store" },
  });
}

/**
 * Kit counterpart of memberReadBoundary. The whole render runs inside one
 * capture, and the response is read to completion inside it, so deferred and
 * streamed reads finish before the audit decision. Only that fully read copy
 * can leave, and only after its audit row is written.
 */
export function memberReadResponse(
  meta: MemberReadMeta,
  declaration: ReadDeclaration | (() => ReadDeclaration | undefined),
  write: AccessSink,
  render: () => Promise<Response>,
  // Post-release side effect for work that is not a member read (the Hono
  // handler's anonymous board-view log is the model: src/leaderboards/
  // routes.tsx writes it only after memberReadBoundary releases a 200).
  // Runs only when the boundary released the buffered response, and outside
  // the capture (captures.exit, like the audit sink), so its writes can
  // neither be refused by the capture nor refuse it. The hook owns its own
  // fail-open policy; a throwing hook never replaces a released response.
  afterRelease?: (response: Response) => Promise<void>,
): Promise<Response> {
  const capture: Capture = { subjects: new Set(), failed: false, pending: 0 };
  return captures.run(capture, async () => {
    let buffered: Response | undefined;
    try {
      buffered = await bufferedCopy(await render());
    } catch (error) {
      capture.failed = true;
      alertRequestError(error, meta);
    }
    const declared = typeof declaration === "function" ? declaration() : declaration;
    const release = await releaseAfterAudit(capture, declared, write, meta);
    if (buffered && release.released) {
      buffered.headers.set("cache-control", "private, no-store");
      if (afterRelease) {
        try {
          await captures.exit(() => afterRelease(buffered));
        } catch {
          // Fail-open by contract above: the released response still stands.
        }
      }
      return buffered;
    }
    return refusedResponse();
  });
}
