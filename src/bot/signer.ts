// Signature on every request to the bot's POST /internal/actions. Ported byte-for-byte from
// two-web app/Services/Bot/InternalActionSigner.php (wire format: two-bot docs/INTERNAL_ACTIONS.md §1).
//
//   canonical = "POST\n/internal/actions\n{timestamp}\n{nonce}\n{sha256_hex(raw_body)}"
//   signature = "sha256=" + hex(hmac_sha256(shared_secret, canonical))
//
// The caller must send the exact string it signed (see encodeCanonicalJson). Nothing here logs:
// the bot answers a bad signature and an unknown key id identically, so a signing bug arrives as
// an unexplained `unauthorized`; the vectors in test/bot-signer.test.ts are the tiebreaker.
export const INTERNAL_ACTIONS_PATH = "/internal/actions";

const enc = new TextEncoder();

const hex = (buf: ArrayBuffer): string =>
  [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

export async function sha256Hex(data: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", enc.encode(data)));
}

export async function hmacSha256Hex(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  return hex(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
}

export type SigningHeaders = {
  "X-TWO-Key-Id": string;
  "X-TWO-Timestamp": string;
  "X-TWO-Nonce": string;
  "X-TWO-Signature": string;
};

export async function signInternalAction(
  keyId: string,
  secret: string,
  body: string,
  timestamp: number,
  nonce: string,
): Promise<SigningHeaders> {
  const canonical = ["POST", INTERNAL_ACTIONS_PATH, String(timestamp), nonce, await sha256Hex(body)].join("\n");
  return {
    "X-TWO-Key-Id": keyId,
    "X-TWO-Timestamp": String(timestamp),
    "X-TWO-Nonce": nonce,
    "X-TWO-Signature": `sha256=${await hmacSha256Hex(secret, canonical)}`,
  };
}

// The bytes the legacy client puts on the wire: PHP json_encode with JSON_UNESCAPED_SLASHES |
// JSON_UNESCAPED_UNICODE. JSON.stringify already leaves "/" and non-ASCII raw; the one difference
// is U+2028/U+2029, which PHP still escapes (no JSON_UNESCAPED_LINE_TERMINATORS). Floats are not
// supported: no bot action carries one.
export function encodeCanonicalJson(payload: unknown): string {
  return JSON.stringify(payload).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

export function newNonce(): string {
  return hex(crypto.getRandomValues(new Uint8Array(16)).buffer);
}
