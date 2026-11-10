import type { Context } from "hono";
import { discordFetch } from "../discord-http";
import type { Env } from "../env";
import { qaTokenMatches } from "../qa";
import { clientKey } from "../throttle";
import { Shell } from "./pages/shell";

type Vars = { Bindings: Env };
type OpsRecord = {
  epoch: number;
  overrides: Record<string, string>;
  baseline: Record<string, string>;
  enforcement: string;
};

// Producer contract (/ops/config): stored overrides are capped at 4096 characters
// when written, but the boot baseline forwards environment strings verbatim, bounded
// only by the platform's 5 KB variable limit. The 256 KiB reader cap bounds the whole
// record, so only the per-entry limit differs between the two maps.
const MAX_OVERRIDE_VALUE = 4096;
const MAX_BASELINE_VALUE = 5120;

function stringMap(value: unknown, maxValue: number): value is Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  return (
    entries.length <= 256 &&
    entries.every(
      ([key, entry]) =>
        key.length > 0 &&
        key.length <= 128 &&
        typeof entry === "string" &&
        entry.length <= maxValue,
    )
  );
}

function recordFrom(value: unknown): OpsRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (
    !Number.isSafeInteger(row.epoch) ||
    (row.epoch as number) < 0 ||
    !stringMap(row.overrides, MAX_OVERRIDE_VALUE) ||
    !stringMap(row.baseline, MAX_BASELINE_VALUE) ||
    typeof row.enforcement !== "string" ||
    !row.enforcement.length ||
    row.enforcement.length > 128
  )
    return null;
  return {
    epoch: row.epoch as number,
    overrides: row.overrides,
    baseline: row.baseline,
    enforcement: row.enforcement,
  };
}

async function readRecord(env: Env): Promise<OpsRecord | null> {
  try {
    const endpoint = new URL(env.BOT_ENDPOINT_URL ?? "");
    if (
      endpoint.protocol !== "https:" ||
      !endpoint.hostname ||
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash
    )
      return null;
    // The configured bot origin is the only credential recipient. Never follow
    // redirects, derive a destination from the request, or forward its headers.
    const response = await discordFetch(new URL("/ops/config", endpoint).href, {
      method: "GET",
      redirect: "manual",
      headers: { authorization: `Bearer ${env.OPS_CONTROL_TOKEN}`, accept: "application/json" },
    });
    if (response.status !== 200) return null;
    // discordFetch owns the existing 5-second fetch+body deadline and 256 KiB
    // cumulative byte cap. Unreadable/oversize bodies are empty and fail JSON.
    return recordFrom(await response.json());
  } catch {
    // Never echo an upstream body, transport error, endpoint or credential.
    return null;
  }
}

// Pre-authentication guess cap, per client and per isolate like the bot's own control
// bucket (10 tokens, 1/s): a presented credential takes a token before the digest
// comparison and a match returns it, so only failed guesses drain a client. DB-free by
// design; bounded to MAX_CLIENTS entries, evicting the least recently seen.
const ATTEMPT_CAPACITY = 10;
const ATTEMPT_REFILL_PER_SECOND = 1;
const MAX_CLIENTS = 1024;
const attempts = new Map<string, { tokens: number; at: number }>();

/** Returns 0 when the attempt is allowed, else the whole seconds until a token is back. */
function takeAttempt(client: string, now = Date.now()): number {
  const prior = attempts.get(client);
  const tokens = prior
    ? Math.min(
        ATTEMPT_CAPACITY,
        prior.tokens + (Math.max(0, now - prior.at) / 1000) * ATTEMPT_REFILL_PER_SECOND,
      )
    : ATTEMPT_CAPACITY;
  attempts.delete(client);
  if (attempts.size >= MAX_CLIENTS) attempts.delete(attempts.keys().next().value as string);
  const allowed = tokens >= 1;
  attempts.set(client, { tokens: allowed ? tokens - 1 : tokens, at: now });
  return allowed ? 0 : Math.ceil((1 - tokens) / ATTEMPT_REFILL_PER_SECOND);
}

function refundAttempt(client: string): void {
  const bucket = attempts.get(client);
  if (bucket) bucket.tokens = Math.min(ATTEMPT_CAPACITY, bucket.tokens + 1);
}

// Characters that render as nothing or reorder text. Spelled out so a stored value
// never looks like another one.
const INVISIBLE = /[\u007f-\u009f\u00ad\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2069\ufeff]/g;

/** A stored string is shown quoted and escaped, so " 1" and "1" (or "") stay distinct. */
function quoted(value: string): string {
  return JSON.stringify(value).replace(
    INVISIBLE,
    (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

/** Present values are quoted code; absence is an unquoted emphasis, never a value. */
function Stored({
  map,
  name,
  absent,
}: {
  map: Record<string, string>;
  name: string;
  absent: string;
}) {
  return Object.hasOwn(map, name) ? <code>{quoted(map[name] as string)}</code> : <em>{absent}</em>;
}

function Panel({ record, observedAt }: { record: OpsRecord | null; observedAt: string }) {
  const keys = record ? Object.keys({ ...record.baseline, ...record.overrides }).sort() : [];
  return (
    <Shell
      title="Operator overrides"
      audience="control-token holders only"
      stylesheet="/operator-overrides-theme.css"
    >
      <section class="ops-overrides">
        <p class="strap">Read-only · PUT API-only and security-gated</p>
        <h1>Operator overrides</h1>
        {record ? (
          <>
            <dl class="facts">
              <div>
                <dt>Record epoch</dt>
                <dd>{record.epoch}</dd>
              </div>
              <div>
                <dt>Reported enforcement</dt>
                <dd>{record.enforcement}</dd>
              </div>
              <div>
                <dt>Snapshot (UTC)</dt>
                <dd>
                  <time datetime={observedAt}>{observedAt}</time>
                </dd>
              </div>
            </dl>
            <p>This snapshot does not confirm runtime application.</p>
            {Object.keys(record.overrides).length === 0 ? <p>No overrides are set.</p> : null}
            {keys.length ? (
              <table class="admin-table">
                <caption>Operator record</caption>
                <thead>
                  <tr>
                    <th scope="col">Setting</th>
                    <th scope="col">Override</th>
                    <th scope="col">Baseline</th>
                  </tr>
                </thead>
                <tbody>
                  {keys.map((key) => (
                    <tr>
                      <th scope="row">
                        <code>{key}</code>
                      </th>
                      <td>
                        <Stored map={record.overrides} name={key} absent="not set" />
                      </td>
                      <td>
                        <Stored map={record.baseline} name={key} absent="not reported" />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : null}
          </>
        ) : (
          <div class="notice" role="status">
            <h2>Operator record unavailable</h2>
            <p>No cached record. Check bot availability; reload with your bearer header.</p>
          </div>
        )}
        <h2>Freshness and staleness</h2>
        <p>No auto-refresh; open tabs can be arbitrarily stale. Reload with your bearer header.</p>
        <p>
          Runtime polling is configured separately and this page cannot show whether it is on. When
          on, it polls every 15 seconds. The last-good limit of 300 seconds is checked only when a
          later poll completes, so an unrefreshed record can stay in effect longer; outages can
          delay updates.
        </p>
      </section>
    </Shell>
  );
}

export function opsOverridesMethodRefused(c: Context<Vars>): Response {
  c.header("cache-control", "private, no-store");
  c.header("allow", "GET, HEAD");
  return c.json({ error: "method_not_allowed" }, 405);
}

/** Token-only admission, deliberately before every session/admin middleware. */
export async function opsOverridesHandler(c: Context<Vars>): Promise<Response> {
  c.header("cache-control", "private, no-store");
  c.header("referrer-policy", "no-referrer");
  const configured = c.env.OPS_CONTROL_TOKEN;
  if (
    !configured ||
    configured.length < 32 ||
    configured.length > 512 ||
    configured.trim() !== configured
  ) {
    return c.text("Not found", 404);
  }
  const url = new URL(c.req.url);
  if (url.search || c.req.url.includes("?")) return c.text("Query not allowed", 400);
  const authorization = c.req.header("authorization") ?? "";
  const presented = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  let admitted = false;
  if (presented) {
    const client = clientKey(c);
    const wait = takeAttempt(client);
    if (wait) {
      c.header("retry-after", String(wait));
      return c.text("Too many attempts", 429);
    }
    admitted = await qaTokenMatches(configured, presented);
    if (admitted) refundAttempt(client);
  }
  if (!admitted) {
    c.header("www-authenticate", "Bearer");
    return c.html(
      <Shell title="Operator access required" audience="control-token holders only">
        <section>
          <h1>Operator access required</h1>
          <p>Control bearer required, not a Discord session. Never put tokens in URLs.</p>
        </section>
      </Shell>,
      401,
    );
  }
  const record = await readRecord(c.env);
  return c.html(
    <Panel record={record} observedAt={new Date().toISOString()} />,
    record ? 200 : 503,
  );
}
