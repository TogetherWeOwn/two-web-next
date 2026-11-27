const path = process.argv[2];
// A route-family switch reaches the edge a little after `wrangler deploy`
// returns, so poll briefly instead of failing on the first stale answer.
const attempts = 6;
const delayMs = 10_000;

async function probe() {
  const response = await fetch(`https://next.togetherweown.com${path}`, {
    method: "GET",
    credentials: "omit",
    redirect: "manual",
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  const { status, headers } = response;
  try {
    await response.body?.cancel();
  } catch {
    // The status and renderer received with the headers determine the verdict.
    console.warn("Warning: could not cancel the staging Kit response body");
  }
  if (status !== 200) throw new Error(`GET ${path} returned HTTP ${status}; expected 200`);
  if (headers.get("x-two-renderer") !== "kit") {
    throw new Error(`GET ${path} did not return x-two-renderer: kit`);
  }
}

try {
  if (!["/events", "/", "/join"].includes(path)) throw new Error("Unsupported Kit probe path");
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await probe();
      console.log(`GET ${path}: HTTP 200, x-two-renderer: kit (attempt ${attempt})`);
      break;
    } catch (error) {
      if (attempt === attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
} catch (error) {
  console.error(`Staging Kit renderer check failed: ${error.message}`);
  process.exitCode = 1;
}
