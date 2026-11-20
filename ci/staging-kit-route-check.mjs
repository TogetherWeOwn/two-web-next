const path = process.argv[2];
// A route-family switch reaches the edge a little after `wrangler deploy`
// returns, so poll briefly instead of failing on the first stale answer.
const attempts = Number(process.env.KIT_ROUTE_CHECK_ATTEMPTS ?? 6);
const delayMs = Number(process.env.KIT_ROUTE_CHECK_DELAY_MS ?? 10_000);

async function probe() {
  const response = await fetch(`https://next.togetherweown.com${path}`, {
    method: "GET",
    credentials: "omit",
    redirect: "manual",
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  const { status, headers } = response;
  await response.body?.cancel();
  if (status !== 200) throw new Error(`GET ${path} returned HTTP ${status}; expected 200`);
  if (headers.get("x-two-renderer") !== "kit") {
    throw new Error(`GET ${path} did not return x-two-renderer: kit`);
  }
}

try {
  if (!["/events", "/", "/join"].includes(path)) throw new Error("Unsupported Kit probe path");
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await probe();
      console.log(`GET ${path}: HTTP 200, x-two-renderer: kit (attempt ${attempt})`);
      lastError = undefined;
      break;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  if (lastError) throw lastError;
} catch (error) {
  console.error(`Staging Kit renderer check failed: ${error.message}`);
  process.exitCode = 1;
}
