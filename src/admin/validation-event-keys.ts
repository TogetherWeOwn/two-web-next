// Event-key minting (W11). Pure move out of `./validation`: the route key is
// minted server-side at create and immutable once written — parseEventForm
// refuses forged event_key/eventKey input (legacy EventKeyTest).
// `./validation` re-exports every name below, so all existing importers keep
// working untouched.

const ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function ulidRandom(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let out = "";
  for (const b of bytes) {
    // Two Crockford chars per byte would be 32 chars; take 16 chars by
    // folding each byte to one 5-bit symbol. Randomness is all that matters
    // here — time-ordering lives in the 10-char time part.
    out += ULID_ALPHABET[b! & 31];
  }
  return out;
}

/** ULID (26-char Crockford base32), matching legacy `Str::ulid()` event keys. */
export function newEventKey(nowMs: number = Date.now()): string {
  let time = nowMs;
  let timePart = "";
  for (let i = 0; i < 10; i++) {
    timePart = ULID_ALPHABET[time % 32] + timePart;
    time = Math.floor(time / 32);
  }
  return timePart + ulidRandom().slice(0, 16);
}
