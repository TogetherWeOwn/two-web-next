import { get } from "node:https";

export const ELIGIBLE_PATH = "/__analytics-fixture";
export const PRIVACY_PATH = "/privacy";
const JURISDICTIONS = ["eu", "uk", "unknown", "allowed"];
const MAX_HTML_BYTES = 1_048_576;

export function requireAnalyticsTarget(args) {
  const [targetFlag, rawOrigin, expectFlag, jurisdiction] = args;
  if (args.length !== 4 || targetFlag !== "--target" || expectFlag !== "--expect") {
    throw new Error("Use --target <isolated HTTPS origin> --expect <eu|uk|unknown|allowed>");
  }
  const url = URL.parse(rawOrigin);
  const host = url?.hostname ?? "";
  const excludedZones = ["togetherweown.com", "workers.dev", "pages.dev"];
  if (
    rawOrigin !== `https://${host}` ||
    host.length > 253 ||
    !/^analytics-synthetic\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host) ||
    excludedZones.some((zone) => host === zone || host.endsWith(`.${zone}`))
  ) {
    throw new Error(
      "Target must be a canonical analytics-synthetic HTTPS origin in a separate zone",
    );
  }
  if (!JURISDICTIONS.includes(jurisdiction)) {
    throw new Error("Expected jurisdiction must be eu, uk, unknown or allowed");
  }
  return { origin: rawOrigin, jurisdiction };
}

export async function readAnalyticsDocument(target, path) {
  // Validate at the actual network boundary too. There are just two GETs,
  // with no credentials, cookies, geolocation overrides or redirect handling.
  const { origin, jurisdiction } = requireAnalyticsTarget([
    "--target",
    target.origin,
    "--expect",
    target.jurisdiction,
  ]);
  if (path !== ELIGIBLE_PATH && path !== PRIVACY_PATH) throw new Error("Unsupported fixture path");
  const response = await new Promise((resolve, reject) => {
    const request = get(
      `${origin}${path}`,
      {
        agent: false,
        rejectUnauthorized: true,
        signal: AbortSignal.timeout(10_000),
        headers: { accept: "text/html", "cache-control": "no-cache" },
      },
      resolve,
    );
    request.on("error", reject);
  });

  try {
    if (
      response.statusCode !== 200 ||
      !/^text\/html(?:\s*;|$)/i.test(response.headers["content-type"] ?? "")
    ) {
      throw new Error("Expected a direct 200 HTML response from the synthetic target");
    }
    if (
      response.headers["x-two-analytics-fixture"] !== "isolated-v1" ||
      response.headers["x-two-analytics-jurisdiction"] !== jurisdiction ||
      response.headers["set-cookie"] !== undefined
    ) {
      throw new Error(
        "Missing isolation marker, mismatched edge jurisdiction or unexpected cookie",
      );
    }
    const chunks = [];
    let bytes = 0;
    for await (const chunk of response) {
      bytes += chunk.length;
      if (bytes > MAX_HTML_BYTES) throw new Error("Synthetic HTML exceeds the size limit");
      chunks.push(chunk);
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  } finally {
    response.destroy();
  }
}
