import { isDeepStrictEqual } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import { env as baseEnv } from "./helpers/member-data";

const PATH = "/csp-reports";
const REQUEST_ID = "0123456789abcdef-IAD";
const SYNTHETIC = "fixture-only-csp-marker";
const REPORT = JSON.stringify({ "csp-report": { "script-sample": SYNTHETIC } });
const MALFORMED = `{${SYNTHETIC}`;
const MALFORMED_BYTES = new TextEncoder().encode(MALFORMED).length;
const OVERSIZE_BYTES = 8_193;

// Validate the emitted shape in memory. Keep only counts, including on failure.
function countDiagnostics() {
  const counts = { violation: 0, malformed: 0, oversize: 0, invalid: 0, http: 0, unexpected: 0 };
  const unexpected = () => {
    counts.unexpected++;
  };
  vi.stubGlobal("console", {
    ...console,
    warn(event: unknown, fields: unknown, ...extra: unknown[]) {
      if (extra.length > 0) return unexpected();
      if (
        event === "csp.report.violation" &&
        isDeepStrictEqual(fields, {
          blocked_uri: null,
          violated_directive: null,
          document_uri: null,
          source_file: null,
          line_number: null,
        })
      ) {
        counts.violation++;
      } else if (
        event === "csp.report.malformed" &&
        isDeepStrictEqual(fields, { bytes: MALFORMED_BYTES })
      ) {
        counts.malformed++;
      } else if (
        event === "csp.report.dropped_oversize" &&
        isDeepStrictEqual(fields, { bytes: OVERSIZE_BYTES })
      ) {
        counts.oversize++;
      } else if (
        event === "operator.config.invalid" &&
        isDeepStrictEqual(fields, {
          variable: "CSP_REPORT_SAMPLE_RATE",
          action: "using_default",
        })
      ) {
        counts.invalid++;
      } else {
        unexpected();
      }
    },
    log(line: unknown, ...extra: unknown[]) {
      if (typeof line !== "string" || extra.length > 0) return unexpected();
      try {
        const { duration_ms, ...fields } = JSON.parse(line);
        if (
          Number.isFinite(duration_ms) &&
          duration_ms >= 0 &&
          isDeepStrictEqual(fields, {
            event: "http.request",
            request_id: REQUEST_ID,
            method: "POST",
            route: PATH,
            status: 204,
            colo: null,
            error_class: null,
            build_sha: null,
            release: null,
          })
        ) {
          counts.http++;
        } else {
          unexpected();
        }
      } catch {
        unexpected();
      }
    },
    debug: unexpected,
    info: unexpected,
    error: unexpected,
  });
  return counts;
}

// name, configured rate, deterministic draw, admitted, takes a draw, warns about config
const CASES = [
  ["off, even at draw zero", "0", 0, 0, 0, 0],
  ["negative clamps off", "-0.5", 0, 0, 0, 0],
  ["on", "1", 0.99, 1, 0, 0],
  ["above one clamps on", "1.5", 0.99, 1, 0, 0],
  ["below the boundary", "0.5", 0.49, 1, 1, 0],
  ["at the inclusive boundary", "0.5", 0.5, 1, 1, 0],
  ["above the boundary", "0.5", 0.51, 0, 1, 0],
  ["numeric prefix", "0.5fixture", 0.51, 0, 1, 0],
  ["unset defaults on", undefined, 0.99, 1, 0, 0],
  ["blank defaults on", " ", 0.99, 1, 0, 0],
  ["invalid defaults on and warns once", SYNTHETIC, 0.99, 1, 0, 1],
] as const;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it.each(["Hono", "Kit enabled", "Kit disabled"])(
  "pins CSP report sampling through %s",
  async (mode) => {
    // Each leg gets a fresh isolate budget and a fresh once-per-setting warning.
    vi.resetModules();
    const { fetchApp } = await import("./helpers/fetch-app");
    const { dispatchHookRequest, KIT_RENDERER_HEADER, KIT_RENDERER_VALUE } = await import(
      "../src/route-ownership"
    );
    const { fetchKitCspReports } = await import("../src/kit-csp-reports-fetch");
    const enabled = mode === "Kit enabled";
    let ioReads = 0;
    function unexpectedIO(): never {
      ioReads++;
      throw new Error("Unexpected IO in the CSP sampling fixture");
    }
    vi.stubGlobal("fetch", unexpectedIO);
    const random = vi.spyOn(Math, "random");

    async function send(body: string | null, rate: string | undefined, draw: number) {
      const counts = countDiagnostics();
      random.mockReset().mockReturnValue(draw);
      const env = {
        ...baseEnv,
        CSP_REPORT_SAMPLE_RATE: rate,
        get DB() {
          return unexpectedIO();
        },
        get SESSION_STORE() {
          return unexpectedIO();
        },
      };
      const url = new URL(PATH, env.APP_URL);
      const request = new Request(url, {
        method: "POST",
        headers: {
          "cf-ray": REQUEST_ID,
          "content-type": "application/csp-report",
          origin: "https://reporter.example.test",
        },
        body,
      });
      let kitCalls = 0;
      let fallbackCalls = 0;
      const response =
        mode === "Hono"
          ? await fetchApp(request, env)
          : await dispatchHookRequest(
              { request, url, route: { id: PATH } },
              {
                appUrl: env.APP_URL,
                honoFetch(req) {
                  fallbackCalls++;
                  return fetchApp(req, env);
                },
                async resolve(event) {
                  kitCalls++;
                  const resolved = await fetchKitCspReports(event.request, env);
                  if (!resolved) throw new Error("The CSP adapter declined the fixture request");
                  return resolved;
                },
                sessionFor: unexpectedIO,
                apiFamilies: [
                  {
                    flag: enabled ? "true" : "false",
                    routes: [{ method: "POST", path: PATH, enabled: true, reads: "public" }],
                  },
                ],
              },
            );
      expect(kitCalls).toBe(enabled ? 1 : 0);
      expect(fallbackCalls).toBe(mode === "Kit disabled" ? 1 : 0);
      expect(ioReads).toBe(0);
      expect(response.headers.get(KIT_RENDERER_HEADER)).toBe(enabled ? KIT_RENDERER_VALUE : null);
      expect(response.status).toBe(204);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.body === null).toBe(true);
      expect(response.headers.has("set-cookie")).toBe(false);
      return { ...counts, draws: random.mock.calls.length };
    }

    const quiet = { violation: 0, malformed: 0, oversize: 0, invalid: 0, http: 1, unexpected: 0 };
    for (const [name, rate, draw, admitted, draws, invalid] of CASES) {
      expect(await send(REPORT, rate, draw), `${name}, valid report`).toEqual({
        ...quiet,
        violation: admitted,
        invalid,
        draws,
      });
      expect(await send(MALFORMED, rate, draw), `${name}, malformed report`).toEqual({
        ...quiet,
        malformed: admitted,
        draws,
      });
    }
    expect(await send(null, "1", 0.5)).toEqual({ ...quiet, draws: 0 });
    expect(await send("x".repeat(OVERSIZE_BYTES), "0", 0.5)).toEqual({
      ...quiet,
      oversize: 1,
      draws: 0,
    });
  },
);

it("declines other methods and nonliteral paths at the detached CSP boundary", async () => {
  const { fetchKitCspReports } = await import("../src/kit-csp-reports-fetch");
  for (const [method, path] of [
    ["GET", PATH],
    ["POST", "/%63sp-reports"],
    ["POST", `${PATH}/`],
  ] as const) {
    expect(
      fetchKitCspReports(new Request(new URL(path, baseEnv.APP_URL), { method }), baseEnv),
    ).toBeNull();
  }
});
