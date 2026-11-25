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
  const dnsName = /^analytics-synthetic\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
  const excluded = excludedZones.some((zone) => host.endsWith(`.${zone}`));
  if (rawOrigin !== `https://${host}` || host.length > 253 || !dnsName.test(host) || excluded) {
    throw new Error("Target must be a canonical analytics-synthetic HTTPS origin");
  }
  if (!JURISDICTIONS.includes(jurisdiction)) {
    throw new Error("Expected jurisdiction must be eu, uk, unknown or allowed");
  }
  return { origin: rawOrigin, jurisdiction };
}

export async function readAnalyticsDocument({ origin, jurisdiction }, path) {
  // The CLI validates origin before calling this reader. Only direct GETs.
  if (path !== ELIGIBLE_PATH && path !== PRIVACY_PATH) throw new Error("Unsupported fixture path");
  const options = {
    agent: false,
    rejectUnauthorized: true,
    signal: AbortSignal.timeout(10_000),
    headers: { accept: "text/html", "cache-control": "no-cache" },
  };
  const response = await new Promise((resolve, reject) => {
    get(`${origin}${path}`, options, resolve).on("error", reject);
  });
  try {
    const { headers, statusCode } = response;
    if (statusCode !== 200 || !/^text\/html(?:\s*;|$)/i.test(headers["content-type"] ?? "")) {
      throw new Error("Expected a direct 200 HTML response from the synthetic target");
    }
    if (
      headers["x-two-analytics-fixture"] !== "isolated-v1" ||
      headers["x-two-analytics-jurisdiction"] !== jurisdiction ||
      headers["set-cookie"] !== undefined
    ) {
      throw new Error("Synthetic target response failed admission");
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
