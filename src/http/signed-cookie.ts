const hmac = { name: "HMAC", hash: "SHA-256" };
const utf8 = new TextEncoder();

function importKey(secret: string, usage: "sign" | "verify") {
  return crypto.subtle.importKey("raw", utf8.encode(secret), hmac, false, [usage]);
}

async function encodeSignedValue(value: string, secret: string): Promise<string> {
  const key = await importKey(secret, "sign");
  const mac = await crypto.subtle.sign(hmac.name, key, utf8.encode(value));
  return encodeURIComponent(`${value}.${btoa(String.fromCharCode(...new Uint8Array(mac)))}`);
}

/** Verify an encoded wire value. Like Hono, the MAC covers the value, not the cookie name. */
export async function verifySignedCookie(encoded: string, secret: string): Promise<string | null> {
  if (!secret) return null;
  let value: string;
  let mac: Uint8Array<ArrayBuffer>;
  try {
    const decoded = decodeURIComponent(encoded);
    const separator = decoded.lastIndexOf(".");
    if (separator < 0) return null;
    value = decoded.slice(0, separator);
    const signature = decoded.slice(separator + 1);
    if (!/^[A-Za-z0-9+/]{43}=$/.test(signature)) return null;
    mac = Uint8Array.from(atob(signature), (byte) => byte.charCodeAt(0));
  } catch {
    return null;
  }
  const key = await importKey(secret, "verify");
  return (await crypto.subtle.verify(hmac.name, key, mac, utf8.encode(value))) ? value : null;
}

const scope = { path: "/", secure: true, httpOnly: true, sameSite: "lax" } as const;

function checkScope(name: string, ageSeconds: number | undefined) {
  if (!/^__Host-[\w!#$%&'*.^`|~+-]+$/.test(name)) throw new Error("Invalid host cookie name");
  if (
    ageSeconds !== undefined &&
    (!Number.isInteger(ageSeconds) || ageSeconds < 0 || ageSeconds > 34_560_000)
  ) {
    throw new RangeError("Invalid cookie Max-Age");
  }
}

/** Raw Set-Cookie for a Response; attribute order matches Hono for this scope. */
export async function signedCookieHeader(
  name: string,
  value: string,
  secret: string,
  ageSeconds?: number,
) {
  checkScope(name, ageSeconds);
  const encoded = await encodeSignedValue(value, secret);
  const age = ageSeconds === undefined ? "" : `; Max-Age=${ageSeconds}`;
  return `${name}=${encoded}${age}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

type CookieWriter = {
  set(
    name: string,
    value: string,
    options: typeof scope & {
      maxAge?: number;
      encode: (value: string) => string;
    },
  ): void;
};

/** For load/action event.cookies; the signed value is already percent-encoded. */
export async function setSignedEventCookie(
  cookies: CookieWriter,
  name: string,
  value: string,
  secret: string,
  ageSeconds?: number,
): Promise<void> {
  checkScope(name, ageSeconds);
  cookies.set(name, await encodeSignedValue(value, secret), {
    ...scope,
    ...(ageSeconds === undefined ? {} : { maxAge: ageSeconds }),
    encode: (encoded) => encoded,
  });
}
