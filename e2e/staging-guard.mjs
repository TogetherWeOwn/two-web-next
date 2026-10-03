export function requireStagingOrigin(raw) {
  // Post-deploy journeys run only against the deployed staging Worker. The
  // origin is pinned exactly: https, the staging host, no port, no
  // credentials, no path, query or hash. Anything else fails closed.
  let url;
  try {
    url = new URL(raw ?? "");
  } catch {
    throw new Error("Staging E2E runs only against https://next.togetherweown.com.");
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "next.togetherweown.com" ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error("Staging E2E runs only against https://next.togetherweown.com.");
  }
  return url.origin;
}
