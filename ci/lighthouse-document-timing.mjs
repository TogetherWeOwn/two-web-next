// Diagnostic only: reads the same already-collected main resource as Lighthouse's
// server-response-time audit. No browser commands, new requests or scoring inputs.
import { Audit } from "lighthouse/core/audits/audit.js";
import { MainResource } from "lighthouse/core/computed/main-resource.js";

const UNKNOWN = "unknown";
const RAY = /^[a-fA-F0-9]{16}(?:-[A-Z]{3})?$/;
const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const TIMING_FIELDS = [
  "dnsStart",
  "dnsEnd",
  "connectStart",
  "connectEnd",
  "sslStart",
  "sslEnd",
  "sendStart",
  "sendEnd",
  "receiveHeadersStart",
  "receiveHeadersEnd",
];

function header(headers, name, valid) {
  const entries = (Array.isArray(headers) ? headers : []).filter(
    (entry) => typeof entry?.name === "string" && entry.name.toLowerCase() === name,
  );
  // Ambiguous/duplicated or unvalidated values cannot be correlation evidence.
  return entries.length === 1 && typeof entries[0].value === "string" && valid(entries[0].value)
    ? entries[0].value
    : UNKNOWN;
}

export function documentTiming(resource, devtoolsLog) {
  const requestId = header(
    resource.responseHeaders,
    "x-request-id",
    (v) => RAY.test(v) || ULID.test(v),
  );
  const cfRay = header(resource.responseHeaders, "cf-ray", (v) => RAY.test(v));
  const request = [...devtoolsLog]
    .reverse()
    .find(
      (entry) =>
        entry.method === "Network.requestWillBeSent" &&
        entry.params?.requestId === resource.requestId &&
        entry.params?.request?.url === resource.url,
    );
  const wallTime = request?.params?.wallTime;
  const timestamp =
    typeof wallTime === "number" && Number.isFinite(wallTime) && wallTime > 0 && wallTime < 8.64e12
      ? new Date(wallTime * 1000).toISOString()
      : UNKNOWN;
  const timingMs = Object.fromEntries(
    TIMING_FIELDS.map((key) => {
      const value = resource.timing?.[key];
      return [
        key,
        typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 86400000
          ? value
          : UNKNOWN,
      ];
    }),
  );
  const serverWaitMs =
    typeof timingMs.receiveHeadersStart === "number" &&
    typeof timingMs.sendEnd === "number" &&
    timingMs.receiveHeadersStart >= timingMs.sendEnd
      ? timingMs.receiveHeadersStart - timingMs.sendEnd
      : UNKNOWN;
  return {
    schemaVersion: 1,
    timestamp,
    requestId,
    cfRay,
    protocol: ["h2", "h3", "http/1.0", "http/1.1"].includes(resource.protocol)
      ? resource.protocol
      : UNKNOWN,
    edgeColo: cfRay !== UNKNOWN && /-[A-Z]{3}$/.test(cfRay) ? cfRay.slice(-3) : UNKNOWN,
    // The served revision is not exposed by the current main-document response.
    // The CI checkout SHA is not evidence of the revision that served a request.
    servingRevision: UNKNOWN,
    timingMs,
    serverWaitMs,
  };
}

export default class DocumentTiming extends Audit {
  static get meta() {
    return {
      id: "main-document-timing",
      title: "Main document timing correlation",
      description:
        "Allowlisted observations from this navigation only; server wait includes network and edge work, not just Worker execution.",
      supportedModes: ["navigation"],
      requiredArtifacts: ["DevtoolsLog", "URL", "GatherContext"],
      scoreDisplayMode: Audit.SCORING_MODES.INFORMATIVE,
    };
  }

  static async audit(artifacts, context) {
    const resource = await MainResource.request(
      { devtoolsLog: artifacts.DevtoolsLog, URL: artifacts.URL },
      context,
    );
    return {
      score: null,
      details: { type: "debugdata", ...documentTiming(resource, artifacts.DevtoolsLog) },
    };
  }
}
