// A request owns its read receipts and its buffered response. A declaration
// never authorizes subsequent queries, and a caught refusal remains a refusal.
import { AsyncLocalStorage } from "node:async_hooks";
import type { Context, Next } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { AccessDecl, AccessSink } from "./access-log";
import { isDatabaseUnavailable } from "./db/errors";

type Capture = {
  subjects: Set<string>;
  failed: boolean;
  pending: number;
  response?: Response;
};
export type NonSensitiveRead = "events" | "featured" | "join-funnel" | "going-counts" | "search-widget" | "timeouts";
type ReadPermit = { capture: Capture; queries: number; classification?: NonSensitiveRead };
const captures = new AsyncLocalStorage<Capture>();
const permits = new AsyncLocalStorage<ReadPermit>();

export class MemberReadRefused extends Error {
  constructor() { super("Member read contract refused."); }
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
export function nonSensitiveRead<T>(classification: NonSensitiveRead, read: () => PromiseLike<T>): Promise<T> {
  return permittedRead(read, classification);
}

async function permittedRead<T>(read: () => PromiseLike<T>, classification?: NonSensitiveRead): Promise<T> {
  const capture = captures.getStore();
  if (!capture) return read();
  capture.pending++;
  try {
    const permit: ReadPermit = { capture, queries: 0, classification };
    // Drizzle builders are lazy thenables: consume them inside the permit.
    const result = await permits.run(permit, async () => await read());
    if (permit.queries !== 1) refuseMemberRead();
    return result;
  } finally { capture.pending--; }
}

/** The DB adapter calls this BEFORE executing a statement, not at declaration. */
export function memberQueryPermit(): ReadPermit | undefined {
  const capture = captures.getStore();
  if (!capture) return undefined;
  const permit = permits.getStore();
  if (!permit || permit.capture !== capture || ++permit.queries !== 1) refuseMemberRead();
  return permit;
}

export function memberReadActive(): boolean { return captures.getStore() !== undefined; }

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
export async function bufferedMemberHtml(c: Context, body: string | Promise<string>, status: ContentfulStatusCode = 200): Promise<Response> {
  const html = await body;
  // Hono JSX nodes are escaped HTML values with a buffered toString renderer.
  const escaped = html as unknown as { isEscaped?: boolean; toString?: unknown } | null;
  if (typeof html !== "string" && !(escaped?.isEscaped === true && typeof escaped.toString === "function")) refuseMemberRead();
  c.res = await c.html(html, status);
  const capture = captures.getStore();
  if (capture) capture.response = c.res;
  return c.res;
}

/** Construct only known buffered bytes. Ordinary Response.body is a stream too. */
export function bufferedMemberText(c: Context, body: string, status: ContentfulStatusCode = 200): Response {
  if (typeof body !== "string") refuseMemberRead();
  const response = c.text(body, status);
  c.res = response;
  const capture = captures.getStore();
  if (capture) capture.response = c.res;
  return c.res;
}

type ReadDeclaration = Omit<AccessDecl, "subjects"> & { viewer: string | null };

/** Renders the caller's sanitized outage envelope (branded HTML or negotiated JSON). */
export type UnavailableResponse = (c: Context) => Response | Promise<Response>;

// Refused contents never leave the boundary. A classified outage or a failed
// audit write renders the caller's outage envelope; any other refusal stays
// the plain contract refusal, so a programming error is never relabelled as
// a database outage. Either way the reason is never in the body.
async function refuse(c: Context, unavailable?: UnavailableResponse): Promise<void> {
  c.res = unavailable ? await unavailable(c) : c.text("Member data is temporarily unavailable.", 503);
  c.header("cache-control", "private, no-store");
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
    try { await next(); } catch (error) { thrown = error; capture.failed = true; }
    if (c.error) capture.failed = true;
    const outage = isDatabaseUnavailable(thrown ?? c.error);
    const declared = typeof declaration === "function" ? declaration() : declaration;
    // Anonymous event pages may return explicitly classified public data only.
    // null is deliberate; missing/invalid viewers never authorize member data.
    if (!declared || (declared.viewer === null ? capture.subjects.size > 0 : !/^\d{10,25}$/.test(declared.viewer))) capture.failed = true;
    // Classification is tied to this exact response. A later stream (declared
    // or not) cannot borrow an earlier buffered response's approval.
    if (capture.failed || capture.pending !== 0 || capture.response !== c.res) {
      await refuse(c, outage ? unavailable : undefined);
      return;
    }
    // Hono header() clones a finalized Response; classify before changing it.
    c.header("cache-control", "private, no-store");
    const subjects = [...capture.subjects].filter((key) => key !== declared!.viewer).sort();
    if (subjects.length === 0) return;
    try {
      const recorded = await captures.exit(() => write({
        viewerDiscordId: declared!.viewer!, viewerUserId: declared!.viewer!,
        resource: declared!.resource, action: declared!.action,
        route: declared!.route, subjectUserIds: subjects,
      }));
      if (!recorded) throw new MemberReadRefused();
    } catch (error) {
      // No SQL, parameters, route URL, subject keys or exception messages.
      console.error("Member read audit failed; refusing contents.", {
        exception: error instanceof Error ? error.constructor.name : "unknown",
      });
      // The audit store is unavailable for this read: an outage, not a contract bug.
      await refuse(c, unavailable);
    }
  });
}
