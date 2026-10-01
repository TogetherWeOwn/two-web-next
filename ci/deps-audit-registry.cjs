const { writeSync } = require('node:fs');
const { gunzipSync, inflateSync, inflateRawSync, brotliDecompressSync } = require('node:zlib');

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value) => typeof value === 'string' && value.trim().length > 0;
const severities = new Set(['info', 'low', 'moderate', 'high', 'critical']);
const maxBytes = 16 * 1024 * 1024;

function validBulk(value) {
  return isObject(value) && Object.entries(value).every(([name, advisories]) => text(name)
    && Array.isArray(advisories) && advisories.every((advisory) => isObject(advisory)
      && Number.isSafeInteger(advisory.id) && advisory.id > 0
      && severities.has(advisory.severity) && text(advisory.vulnerable_versions)
      && (!Object.hasOwn(advisory, 'name') || advisory.name === name)));
}

module.exports = { validBulk };

// Observe the very response npm consumes, without rerouting traffic or copying
// registry credentials. npm may normalize malformed bulk data into a clean audit
// or default a missing severity to high. The parent requires this separate check.
if (process.env.DEPS_AUDIT_REGISTRY_GUARD === '1') {
  const result = { version: 1, valid: true, responses: 0, pending: 0 };
  process.once('exit', () => writeSync(3, JSON.stringify(result)));
  const observed = new WeakSet();
  function observe(request) {
    if (observed.has(request)) return request;
    observed.add(request);
    const path = new URL(request.path, 'https://registry.invalid').pathname;
    const bulk = path.endsWith('/-/npm/v1/security/advisories/bulk');
    const quick = path.endsWith('/-/npm/v1/security/audits/quick');
    if (!bulk && !quick) return request;
    result.pending++;
    // The legacy quick fallback cannot prove that the bulk response was valid.
    if (quick) result.valid = false;
    let finished = false;
    const finish = (valid) => {
      if (finished) return;
      finished = true;
      result.pending--;
      result.responses++;
      result.valid &&= valid;
    };
    request.once('error', () => finish(false));
    request.prependListener('response', (response) => {
      const chunks = [];
      let size = 0;
      const emit = response.emit;
      // Observe without starting/resuming the stream or altering bytes. Validate
      // synchronously before npm sees end and normalizes the decoded JSON.
      response.emit = function (event, ...args) {
        if (event === 'data' && !finished) {
          size += args[0].length;
          if (size <= maxBytes) chunks.push(args[0]);
          else {
            chunks.length = 0;
            finish(false);
          }
        } else if (event === 'aborted' || event === 'error') finish(false);
        else if (event === 'end' && !finished) {
          try {
            if (!bulk || response.statusCode !== 200) finish(false);
            else {
              let body = Buffer.concat(chunks);
              const encoding = response.headers['content-encoding']?.toLowerCase();
              const options = { maxOutputLength: maxBytes };
              if (encoding === 'gzip' || encoding === 'x-gzip') body = gunzipSync(body, options);
              else if (encoding === 'deflate' || encoding === 'x-deflate') {
                // Match npm's handling of zlib-wrapped and raw deflate streams.
                body = (body[0] & 0x0f) === 0x08 ? inflateSync(body, options) : inflateRawSync(body, options);
              } else if (encoding === 'br') body = brotliDecompressSync(body, options);
              else if (encoding && encoding !== 'identity') throw new Error('Unsupported encoding');
              finish(validBulk(JSON.parse(body.toString('utf8'))));
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
  for (const protocol of ['node:http', 'node:https']) {
    const transport = require(protocol);
    for (const method of ['request', 'get']) {
      const original = transport[method];
      transport[method] = function (...args) {
        return observe(original.apply(this, args));
      };
    }
  }
}
