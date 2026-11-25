import assert from "node:assert/strict";

const fixtureKey = "01J0000000000000000000180A";
const nativeRsvp = `/e/${fixtureKey}/rsvp`;
const jsonRsvp = `/events/${fixtureKey}/rsvp`;
const formType = "application/x-www-form-urlencoded";
const html = "text/html";
const json = "application/json";
const padding = "x".repeat(5 * 1024);
const tooLarge = {
  reason: "payload_too_large",
  message: "Reduce the size of your request and try again.",
};

export async function assertResponseContracts({ hono, off, on }) {
  async function check({
    method = "POST",
    path = nativeRsvp,
    accept,
    contentType,
    body,
    crossOrigin,
    status,
    expected,
  }) {
    const mediaType = typeof expected === "string" ? html : json;
    const responses = await Promise.all(
      [hono, off, on].map(async (worker) => {
        const label = `${worker.name}: ${method} ${path} (${status}; ${contentType} → ${accept})`;
        const response = await fetch(`${worker.origin}${path}`, {
          method,
          redirect: "manual",
          signal: AbortSignal.timeout(10_000),
          headers: {
            accept,
            "content-type": contentType,
            origin: crossOrigin ? "https://example.invalid" : worker.origin,
          },
          body,
        });
        const text = await response.text();
        const { headers } = response;
        assert.equal(response.status, status, label);
        assert.equal(headers.get("x-two-renderer"), worker === on ? "kit" : null, label);
        assert.equal(headers.get("content-type")?.split(";", 1)[0], mediaType, label);
        assert.equal(headers.get("cache-control"), "no-store, private", label);
        assert.match(headers.get("vary") ?? "", /(?:^|,\s*)accept(?:\s*,|$)/i, label);
        assert.equal(headers.get("x-content-type-options"), "nosniff", label);
        assert.equal(headers.get("location"), null, label);
        assert.equal(headers.get("set-cookie"), null, label);
        const requestId = headers.get("x-request-id");
        assert.ok(requestId, label);
        if (typeof expected === "string") {
          assert.ok(text.includes(expected), `${label}: expected recovery heading`);
          assert.ok(text.includes(requestId), `${label}: expected support reference`);
        } else {
          assert.deepEqual(JSON.parse(text), { ...expected, request_id: requestId }, label);
        }
        return text.replaceAll(worker.origin, "ORIGIN").replaceAll(requestId, "REQUEST_ID");
      }),
    );
    assert.equal(responses[1], responses[0], `${method} ${path}: Hono fallback body`);
    assert.equal(responses[2], responses[0], `${method} ${path}: native Kit body`);
  }

  // Cross the request and response media types to catch treating Content-Type
  // as Accept. The same-origin refusal runs before either body is parsed.
  await check({
    accept: html,
    contentType: json,
    body: '{"status":"going"}',
    crossOrigin: true,
    status: 403,
    expected: "You do not have access to this",
  });
  await check({
    accept: json,
    contentType: formType,
    body: "status=going",
    crossOrigin: true,
    status: 403,
    expected: { error: "cross_origin" },
  });

  // The action cap rejects these writes before session admission. The form
  // route negotiates its answer while the machine route always returns JSON.
  await check({
    accept: html,
    contentType: formType,
    body: `status=going&pad=${padding}`,
    status: 413,
    expected: "That request is too large",
  });
  await check({
    accept: `${html};q=0.2, ${json}`,
    contentType: formType,
    body: `status=going&pad=${padding}`,
    status: 413,
    expected: tooLarge,
  });
  await check({
    method: "PUT",
    path: jsonRsvp,
    accept: html,
    contentType: json,
    body: JSON.stringify({ status: "going", pad: padding }),
    status: 413,
    expected: tooLarge,
  });
  console.log("PASS Worker HTML and JSON refusals with Kit ownership and Hono fallback");
}
