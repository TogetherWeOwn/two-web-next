const eventsUrl = "https://next.togetherweown.com/events";

try {
  const response = await fetch(eventsUrl, {
    redirect: "manual",
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  const { status, headers } = response;
  await response.body?.cancel();
  if (status !== 200) throw new Error(`GET /events returned HTTP ${status}; expected 200`);
  if (headers.get("x-two-renderer") !== "kit") {
    throw new Error("GET /events did not return x-two-renderer: kit");
  }
  console.log("GET /events: HTTP 200, x-two-renderer: kit");
} catch (error) {
  console.error(`Staging Kit events check failed: ${error.message}`);
  process.exitCode = 1;
}
