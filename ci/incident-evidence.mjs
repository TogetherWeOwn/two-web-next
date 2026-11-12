// Never copy logs to public issues. Extract only known audit identifiers and
// bounded numbers from LHCI assertion blocks; remote bodies, URLs and snippets stay private.
export function qualityMeasurements(log) {
  const measurements = [];
  const pattern =
    /\b(server-response-time|first-contentful-paint|largest-contentful-paint|total-blocking-time|cumulative-layout-shift|speed-index|categories:(?:performance|accessibility|best-practices|seo))\b[^\n]{0,160}\b(maxNumericValue|minScore)\b[^\n]*\n(?:[^\n]*\n){0,4}?[^\n]*expected:\s*(<=|>=|>|<|=)?\s*(\d+(?:\.\d+)?)[^\n]*\n[^\n]*found:\s*(\d+(?:\.\d+)?)/g;
  for (const match of log.matchAll(pattern)) {
    if (match[4].length > 12 || match[5].length > 12) continue;
    measurements.push(
      `${match[1]}: threshold ${match[3] || (match[2] === "maxNumericValue" ? "<=" : ">=")}${match[4]}; measured ${match[5]}`,
    );
    if (measurements.length === 20) break;
  }
  return measurements;
}

async function boundedText(response, limit) {
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) throw new Error("Incident evidence exceeded response size cap");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function githubApi(token, fetchImpl = fetch) {
  return async (method, path, body) => {
    const prefix = "/repos/TogetherWeOwn/two-web-next/";
    if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//") || path.includes("\\"))
      throw new Error("Invalid incident API path");
    const url = new URL(`https://api.github.com${prefix.slice(0, -1)}${path}`);
    if (!url.pathname.startsWith(prefix)) throw new Error("Invalid incident API path");
    const response = await fetchImpl(
      url.href,
      {
        method,
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "Content-Type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
    );
    if (!response.ok) {
      const error = new Error(`Incident API ${method} failed (HTTP ${response.status})`);
      error.status = response.status;
      throw error;
    }
    return JSON.parse(await boundedText(response, 2 * 1024 * 1024));
  };
}

export async function jobMeasurements(token, id, fetchImpl = fetch) {
  if (!Number.isSafeInteger(id) || id <= 0) return [];
  const response = await fetchImpl(
    `https://api.github.com/repos/TogetherWeOwn/two-web-next/actions/jobs/${id}/logs`,
    {
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
    },
  );
  if (response.status !== 302) throw new Error("Quality log redirect unavailable");
  const location = new URL(response.headers.get("location"));
  if (
    location.protocol !== "https:" ||
    location.username ||
    location.password ||
    !(
      location.hostname.endsWith(".blob.core.windows.net") ||
      location.hostname.endsWith(".actions.githubusercontent.com")
    )
  ) {
    throw new Error("Quality log redirect host refused");
  }
  // The signed log download gets no token and follows no further redirects.
  const download = await fetchImpl(location, {
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (!download.ok) throw new Error("Quality log download unavailable");
  return qualityMeasurements(await boundedText(download, 8 * 1024 * 1024));
}
