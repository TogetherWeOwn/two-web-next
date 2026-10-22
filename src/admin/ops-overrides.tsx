import type { Context } from "hono";
import { discordFetch } from "../discord-http";
import type { Env } from "../env";
import { qaTokenMatches } from "../qa";
import { Shell } from "./pages/shell";

type Vars = { Bindings: Env };
type OpsRecord = {
  epoch: number;
  overrides: Record<string, string>;
  baseline: Record<string, string>;
  enforcement: string;
};

function stringMap(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  return (
    entries.length <= 256 &&
    entries.every(
      ([key, entry]) =>
        key.length > 0 && key.length <= 128 && typeof entry === "string" && entry.length <= 4096,
    )
  );
}

function recordFrom(value: unknown): OpsRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (
    !Number.isSafeInteger(row.epoch) ||
    (row.epoch as number) < 0 ||
    !stringMap(row.overrides) ||
    !stringMap(row.baseline) ||
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

function Panel({ record, observedAt }: { record: OpsRecord | null; observedAt: string }) {
  const keys = record
    ? [...new Set([...Object.keys(record.overrides), ...Object.keys(record.baseline)])].sort()
    : [];
  return (
    <Shell title="Operator overrides" audience="control-token holders only">
      <section class="ops-overrides">
        <p class="strap">Incident visibility · read-only</p>
        <h1>Operator overrides</h1>
        <p>No changes can be made here. PUT remains API-only and subject to its security gate.</p>
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
                <dt>Snapshot read at (UTC)</dt>
                <dd>
                  <time datetime={observedAt}>{observedAt}</time>
                </dd>
              </div>
            </dl>
            <p>This is a snapshot, not confirmation that the runtime has applied the record.</p>
            {Object.keys(record.overrides).length === 0 ? (
              <p>No operator overrides are set.</p>
            ) : null}
            {keys.length ? (
              <table class="admin-table">
                <caption>Operator record: override and boot baseline values</caption>
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
                        {Object.hasOwn(record.overrides, key) ? record.overrides[key] : "Not set"}
                      </td>
                      <td>
                        {Object.hasOwn(record.baseline, key)
                          ? record.baseline[key]
                          : "Not reported"}
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
            <p>
              The bot record could not be verified. No cached values are shown. Check bot
              availability and reload with your bearer header.
            </p>
          </div>
        )}
        <h2>Freshness and staleness</h2>
        <p>
          This page does not auto-refresh. Reload with your bearer header for a new snapshot; an
          open tab can become arbitrarily stale.
        </p>
        <p>
          The runtime polls every 15 seconds and retains a last-good record for at most 300 seconds.
          During an outage, application of a newer record is not guaranteed.
        </p>
        <p>
          Overrides take precedence over guild settings while active. Clearing an override falls
          back to guild settings, then boot defaults.
        </p>
      </section>
    </Shell>
  );
}

export function opsOverridesMethodRefused(c: Context<Vars>): Response {
  c.header("cache-control", "private, no-store");
  c.header("allow", "GET, HEAD");
  return c.text("Method not allowed", 405);
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
  if (
    !authorization.startsWith("Bearer ") ||
    !(await qaTokenMatches(configured, authorization.slice(7)))
  ) {
    c.header("www-authenticate", "Bearer");
    return c.html(
      <Shell title="Operator access required" audience="control-token holders only">
        <section>
          <h1>Operator access required</h1>
          <p>Supply the authorized control bearer header to view this read-only panel.</p>
          <p>A Discord session does not grant operator access. Never put a token in the URL.</p>
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
