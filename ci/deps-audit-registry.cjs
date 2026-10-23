const { writeSync } = require("node:fs");
const { gunzipSync, inflateSync, inflateRawSync, brotliDecompressSync } = require("node:zlib");

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value) => typeof value === "string" && value.trim().length > 0;
const severities = new Set(["info", "low", "moderate", "high", "critical"]);
const maxBytes = 16 * 1024 * 1024;

function validBulk(value) {
  return (
    isObject(value) &&
    Object.entries(value).every(
      ([name, advisories]) =>
        text(name) &&
        Array.isArray(advisories) &&
        advisories.every(
          (advisory) =>
            isObject(advisory) &&
            Number.isSafeInteger(advisory.id) &&
            advisory.id > 0 &&
            severities.has(advisory.severity) &&
            text(advisory.vulnerable_versions) &&
            (!Object.hasOwn(advisory, "name") || advisory.name === name),
        ),
    )
  );
}

const transientNetworkCodes = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EPIPE",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ENOTFOUND",
  "ECONNABORTED",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ENETRESET",
  "ENETDOWN",
  "EHOSTDOWN",
]);

module.exports = { validBulk, transientNetworkCodes };

// Observe the very response npm consumes, without rerouting traffic or copying
// registry credentials. npm may normalize malformed bulk data into a clean audit
// or default a missing severity to high. The parent requires this separate check.
if (process.env.DEPS_AUDIT_REGISTRY_GUARD === "1") {
  const result = {
    version: 1,
    valid: true,
    responses: 0,
    pending: 0,
    permanent: false,
    transport: null,
  };
  // Publish progress synchronously, before npm sees it. A timeout/signal can
  // prevent exit handlers from running; it must not erase an invalid response.
  // Only fixed state/codes cross fd 3, never URLs, messages, bodies or credentials.
  const publish = () => writeSync(3, `${JSON.stringify(result)}\n`);
  publish();
  process.once("exit", publish);
  const observed = new WeakSet();
  function observe(request) {
    if (observed.has(request)) return request;
    observed.add(request);
    const path = new URL(request.path, "https://registry.invalid").pathname;
    const bulk = path.endsWith("/-/npm/v1/security/advisories/bulk");
    const quick = path.endsWith("/-/npm/v1/security/audits/quick");
    if (!bulk && !quick) return request;
    result.pending++;
    // The legacy quick fallback cannot prove that the bulk response was valid.
    if (quick) {
      result.valid = false;
      result.permanent = true;
    }
    publish();
    let finished = false;
    let responseStarted = false;
    const finish = (valid, transport = null) => {
      if (finished) return;
      finished = true;
      result.pending--;
      result.responses++;
      result.valid &&= valid;
      if (!valid) {
        result.permanent ||= transport === null;
        result.transport = transport;
      }
      publish();
    };
    request.once("error", (error) =>
      finish(
        false,
        bulk && !responseStarted && transientNetworkCodes.has(error.code)
          ? { kind: "network", code: error.code }
          : null,
      ),
    );
    request.prependListener("response", (response) => {
      responseStarted = true;
      const httpOutage =
        bulk && response.statusCode >= 500 && response.statusCode <= 599
          ? { kind: "http", statusCode: response.statusCode }
          : null;
      // Record permanent HTTP failures before waiting for their body. A 401
      // followed by a stall is still a 401, irrespective of any body tokens.
      if (!bulk || (response.statusCode !== 200 && httpOutage === null)) {
        result.valid = false;
        result.permanent = true;
      }
      publish();
      const chunks = [];
      let size = 0;
      const emit = response.emit;
      // Observe without starting/resuming the stream or altering bytes. Validate
      // synchronously before npm sees end and normalizes the decoded JSON.
      response.emit = function (event, ...args) {
        if (event === "data" && !finished) {
          size += args[0].length;
          if (size <= maxBytes) chunks.push(args[0]);
          else {
            chunks.length = 0;
            finish(false);
          }
        } else if (event === "aborted" || event === "error") finish(false);
        else if (event === "end" && !finished) {
          try {
            if (!bulk || response.statusCode !== 200) finish(false, httpOutage);
            else {
              let body = Buffer.concat(chunks);
              const encoding = response.headers["content-encoding"]?.toLowerCase();
              const options = { maxOutputLength: maxBytes };
              if (encoding === "gzip" || encoding === "x-gzip") body = gunzipSync(body, options);
              else if (encoding === "deflate" || encoding === "x-deflate") {
                // Match npm's handling of zlib-wrapped and raw deflate streams.
                body =
                  (body[0] & 0x0f) === 0x08
                    ? inflateSync(body, options)
                    : inflateRawSync(body, options);
              } else if (encoding === "br") body = brotliDecompressSync(body, options);
              else if (encoding && encoding !== "identity") throw new Error("Unsupported encoding");
              finish(validBulk(JSON.parse(body.toString("utf8"))));
            }
          } catch {
            finish(false);
          }
        }
        return emit.call(this, event, ...args);
      };
    });
    return request;
  }
  // No private npm imports: if npm changes transport, an absent validation result
  // blocks rather than silently losing this boundary check.
  for (const protocol of ["node:http", "node:https"]) {
    const transport = require(protocol);
    for (const method of ["request", "get"]) {
      const original = transport[method];
      transport[method] = function (...args) {
        return observe(original.apply(this, args));
      };
    }
  }
}
