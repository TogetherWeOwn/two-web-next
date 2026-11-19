const BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const RAY_ID = /^[a-fA-F0-9]{16}(?:-[A-Z]{3})?$/;
const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

/** Accept only correlation IDs, never arbitrary client-supplied header text. */
export function safeRequestId(value: unknown): string | undefined {
  return typeof value === "string" && (RAY_ID.test(value) || ULID.test(value)) ? value : undefined;
}

/** 48-bit timestamp + 80 cryptographically random bits, Crockford base32. */
export function newRequestId(): string {
  let value = BigInt(Date.now());
  for (const byte of crypto.getRandomValues(new Uint8Array(10)))
    value = (value << 8n) | BigInt(byte);
  let id = "";
  for (let i = 0; i < 26; i++) {
    id = BASE32[Number(value & 31n)] + id;
    value >>= 5n;
  }
  return id;
}

export function selectRequestId(cfRay: unknown): string {
  return safeRequestId(cfRay) ?? newRequestId();
}
