// Pure loopback-host admission for local fixture tools.
//
// Node's URL parser keeps the brackets on IPv6 hostnames and compresses the
// address, so compact "[::1]" and expanded "[0:0:0:0:0:0:0:1]" both arrive as
// hostname "[::1]". Comparing against the unbracketed form refuses a
// legitimate loopback target; this helper admits exactly the three loopback
// spellings the fixtures accept and nothing else: no 127/8 range, no private
// or remote addresses, no mapped IPv6, no suffix match, no DNS lookup.
//
// Shared by ci/kit-worker-e2e.mjs, ci/kit-worker-dev.mjs and
// bin/json-smoke.mjs, each importing "../lib/loopback-hosts.mjs". Pure and
// offline: importing or calling this module performs no network request,
// subprocess, config write, or database construction.

// The exact loopback spellings a parsed URL hostname may carry. Frozen: the
// admission set is a contract, not a default.
export const LOOPBACK_HOSTNAMES = Object.freeze(["localhost", "127.0.0.1", "[::1]"]);

// Deterministic total predicate over a parsed URL hostname. Returns false for
// anything but the three admitted spellings, including non-string input.
export function isLoopbackHostname(hostname) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}
