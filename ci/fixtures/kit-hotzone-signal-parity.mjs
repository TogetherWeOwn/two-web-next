import assert from "node:assert/strict";
import postgres from "postgres";

const signals = ["joins", "voice", "games"];
const ip = "192.0.2.189";
const bucket = `events-read:${ip}`;
const unknownSignal = /Unknown hot zone signal/;
const badSeason = /That season did not match/;

async function read(worker, path, method = "GET", headers = {}) {
  const response = await fetch(worker.origin + path, {
    method,
    headers: { "cf-connecting-ip": ip, "x-forwarded-for": ip, ...headers },
    redirect: "manual",
    signal: AbortSignal.timeout(10_000),
  });
  const body = await response.text();
  const label = `${worker.name} ${method} ${path}`;
  if (method === "HEAD") assert.equal(body, "", label);
  return { response, body, label };
}

function assertAnswer({ response, label }, status, renderer) {
  assert.equal(response.status, status, label);
  assert.equal(response.headers.get("x-two-renderer"), renderer, label);
  assert.equal(response.headers.get("location"), null, label);
  assert.equal(response.headers.get("set-cookie"), null, label);
}

export async function assertHotzoneSignalParity({ hono, off, on, databaseUrl }) {
  const workers = [hono, off, on];
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    for (const [path, method, status, marker, content, foreignOrigin] of [
      ["/hotzones/bogus", "GET", 404, "kit", unknownSignal],
      ["/hotzones/bogus", "HEAD", 404, "kit"],
      ["/hotzones/bogus?season=invalid", "GET", 400, "kit", badSeason],
      ["/hotzones/bogus?season=invalid", "HEAD", 400, "kit"],
      ["/hotzones/bogus?%73eason=invalid&season=all", "GET", 400, "kit", badSeason],
      ["/hotzones/VOICE", "GET", 404, "kit", unknownSignal],
      ["/hotzones/%E2%98%83", "GET", 404, "kit", unknownSignal],
      ["/%68otzones/%62ogus", "GET", 404, "kit", unknownSignal],
      ["/hotzones/%2576oice", "GET", 404, "kit", unknownSignal],
      ["/hotzones/voice%2Fjoins", "GET", 404, "kit", unknownSignal],
      ["/hotzones/%", "GET", 404, null, unknownSignal],
      ["/hotzones/%FF?season=invalid", "GET", 400, null, badSeason],
      ["/hotzones/%5F%5Fdata.json", "GET", 404, null, unknownSignal],
      ["/Hotzones/voice", "GET", 404, null],
      ["/hotzones/", "GET", 404, null],
      ["/hotzones//", "GET", 404, null],
      ["/hotzones/voice/", "GET", 404, null],
      ["/hotzones/bogus/?season=invalid", "GET", 404, null],
      ["/hotzones/bogus/extra", "GET", 404, null],
      ["/hotzones/bogus/__data.json", "GET", 404, null],
      ["/hotzones/bogus", "OPTIONS", 404, null],
      ["/hotzones/voice", "POST", 404, null],
      ["/hotzones/bogus", "PATCH", 404, null],
      ["/hotzones/bogus", "POST", 403, null, /cross_origin/, true],
    ]) {
      const answers = await Promise.all(
        workers.map((worker) =>
          read(worker, path, method, {
            accept: "application/json",
            origin: foreignOrigin ? "https://other.invalid" : worker.origin,
          }),
        ),
      );
      const [direct] = answers;
      for (const [index, answer] of answers.entries()) {
        assertAnswer(answer, status, index === 2 ? marker : null);
        const requestId = answer.response.headers.get("x-request-id");
        assert.ok(requestId, answer.label);
        if (foreignOrigin) {
          assert.deepEqual(
            JSON.parse(answer.body),
            { error: "cross_origin", request_id: requestId },
            answer.label,
          );
        } else {
          assert.equal(answer.body, direct.body, answer.label);
        }
        assert.equal(
          answer.response.headers.get("cache-control"),
          "no-store, private",
          answer.label,
        );
        for (const name of ["content-type", "vary", "content-security-policy", "x-robots-tag"]) {
          assert.equal(
            answer.response.headers.get(name),
            direct.response.headers.get(name),
            answer.label,
          );
        }
        if (content) assert.match(answer.body, content, answer.label);
        else
          assert.doesNotMatch(
            answer.body,
            /Unknown hot zone signal|That season did not match/,
            answer.label,
          );
        assert.doesNotMatch(answer.body, /data-hotzone-scroll/, answer.label);
      }
    }
    const hits = () =>
      sql`select count(*)::int as n from web_throttle_hits where bucket = ${bucket}`;
    assert.deepEqual(await hits(), [{ n: 0 }], "refusals never charge the public-read budget");

    for (const [path, signal] of [
      ...signals.map((signal) => [`/hotzones/${signal}`, signal]),
      ["/hotzones/%76oice?season=2026-Q3", "voice"],
    ]) {
      for (const method of ["GET", "HEAD"]) {
        for (const [index, worker] of workers.entries()) {
          const answer = await read(worker, path, method);
          assertAnswer(answer, 200, index === 0 ? null : "kit");
          if (method === "GET") {
            assert.ok(answer.body.includes(`<h1>${signal} hot zone</h1>`), answer.label);
            assert.match(answer.body, /data-hotzone-scroll/, answer.label);
          }
        }
      }
    }

    for (const path of ["/hotzones/__data.json", "/hotzones/voice/__data.json"]) {
      for (const worker of [off, on]) {
        const answer = await read(worker, path);
        assertAnswer(answer, 200, "kit");
        assert.doesNotMatch(answer.body, unknownSignal, answer.label);
      }
    }

    // At the existing budget limit the concrete selector still runs normal
    // read admission. The generic matcher still answers before admission.
    await sql`delete from web_throttle_hits where bucket = ${bucket}`;
    await sql`insert into web_throttle_hits (bucket) select ${bucket} from generate_series(1, 60)`;
    for (const [index, worker] of workers.entries()) {
      for (const method of ["GET", "HEAD"]) {
        const answer = await read(worker, "/hotzones/voice", method, {
          accept: "application/json",
        });
        assertAnswer(answer, 429, index === 0 ? null : "kit");
        const retry = answer.response.headers.get("retry-after");
        assert.match(retry ?? "", /^[1-9][0-9]*$/, answer.label);
        assert.equal(
          answer.response.headers.get("cache-control"),
          "no-store, private",
          answer.label,
        );
        assert.equal(answer.response.headers.get("vary"), "Accept", answer.label);
        if (method === "GET") {
          const body = JSON.parse(answer.body);
          assert.equal(body.code, "rate_limited", answer.label);
          assert.equal(body.retry_after, Number(retry), answer.label);
          assert.equal(body.request_id, answer.response.headers.get("x-request-id"), answer.label);
        }
      }
      const unknown = await read(worker, "/hotzones/bogus");
      assertAnswer(unknown, 404, index === 2 ? "kit" : null);
      assert.match(unknown.body, unknownSignal, unknown.label);
    }
    assert.deepEqual(await hits(), [{ n: 60 }], "refusals leave the full window intact");
    console.log(
      "PASS installed Worker Hotzones exact selectors, generic refusals and Hono fallbacks",
    );
  } finally {
    try {
      await sql`delete from web_throttle_hits where bucket = ${bucket}`;
    } finally {
      await sql.end();
    }
  }
}
