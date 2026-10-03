// Token-bearing staging requests (TOG-13046, CISO condition C2 on TOG-13035).
//
// Playwright 1.63 puts the full request headers, including `X-TWO-QA-Auth`,
// into the message of a transport-level `apiRequestContext.post` failure
// (socket hang up, timeout, reset), and the HTML report stores that message.
// The staging repo is public and its failure artifacts are downloadable, so a
// transport error must never leave this module with the call log attached.

const MAX_REASON_LENGTH = 120;
const ERROR_CODE = /^[A-Z][A-Z0-9_]{1,39}$/;

/**
 * Safe, bounded reason for a failed request: the Node error code when there is
 * one, else the first message line only (Playwright appends `Call log:` and
 * the headers after it), with the token scrubbed from what is kept.
 *
 * @param {unknown} error
 * @param {string} [token]
 */
export function transportFailureReason(error, token) {
  const scrub = (text) => (token ? text.split(token).join("[redacted]") : text);
  if (error === null || typeof error !== "object") return "request error";
  const { code, message } = /** @type {{ code?: unknown; message?: unknown }} */ (error);
  if (typeof code === "string" && ERROR_CODE.test(code)) return scrub(code);
  if (typeof message === "string") {
    const line = scrub(message.split(/\r?\n/, 1)[0] ?? "")
      .trim()
      .slice(0, MAX_REASON_LENGTH);
    if (line) return line;
  }
  return "request error";
}

/**
 * Run one token-bearing request. A rejection is rethrown as a fresh error with
 * a reason-only message: no `cause`, no call log, no headers. Only the request
 * itself goes in `send`; assertions on its response stay outside so their own
 * messages are untouched.
 *
 * @template T
 * @param {string} label what failed, e.g. `staging QA login as qa-member`
 * @param {string | undefined} token the secret to scrub from the reason
 * @param {() => Promise<T>} send
 * @returns {Promise<T>}
 */
export async function sendTokenRequest(label, token, send) {
  try {
    return await send();
  } catch (error) {
    throw new Error(`${label} failed: ${transportFailureReason(error, token)}`);
  }
}
