// Test-only fetch stub for the internal-action CLIs. Answers bot
// internal-action calls with ok envelopes so --apply tests exercise the
// success path hermetically: no network, no TLS, no credentials.
//
// Loaded via an extra --import ahead of the CLI script:
//   node --import ./bin/ts-hook.mjs --import ./test/fixtures/answering-bot-fetch.mjs \
//     bin/internal-action-smoke.mjs --apply ...
// Only URLs under the stub origin are intercepted; everything else passes
// through to the real fetch. The stub origin uses .invalid, so a missed
// interception fails closed without touching any network.

const STUB_ORIGIN = "https://bot-stub.invalid/";
const realFetch = globalThis.fetch;
const seenAnnouncementKeys = new Set();

function envelope(result, { replayed = false } = {}) {
  return new Response(JSON.stringify({ ok: true, result, request_id: "stub-request" }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      ...(replayed ? { "Idempotent-Replay": "true" } : {}),
    },
  });
}

function refusal() {
  return new Response(
    JSON.stringify({
      ok: false,
      error: { code: "action_not_allowed", message: "stub: unknown action", retryable: false },
      request_id: "stub-request",
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

globalThis.fetch = async (url, init = {}) => {
  if (!String(url).startsWith(STUB_ORIGIN)) return realFetch(url, init);
  const payload = JSON.parse(String(init.body ?? "{}"));
  const headers = init.headers ?? {};
  const key = headers["Idempotency-Key"] ?? "";
  switch (payload.action) {
    case "role.assign":
      return envelope({ outcome: "assigned" });
    case "announcement.post": {
      const replayed = seenAnnouncementKeys.has(key);
      seenAnnouncementKeys.add(key);
      return envelope({ message_id: `stub-${String(key).slice(0, 8)}` }, { replayed });
    }
    case "event.upsert":
      return envelope({ outcome: "created", event_id: "stub-event-1" });
    default:
      return refusal();
  }
};
