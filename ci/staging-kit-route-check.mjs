const path = process.argv[2];

try {
  if (!["/events", "/", "/join"].includes(path)) throw new Error("Unsupported Kit probe path");
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
  console.log(`GET ${path}: HTTP 200, x-two-renderer: kit`);
} catch (error) {
  console.error(`Staging Kit renderer check failed: ${error.message}`);
  process.exitCode = 1;
}
