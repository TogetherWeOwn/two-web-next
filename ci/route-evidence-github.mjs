import { readGitHubMetadataJson } from "./github-metadata-json.mjs";

// This client is for GitHub metadata only. Artifact bytes need a separate,
// bounded download path and must never provide a URL to this client.
const endpoint =
  /^(?:\/actions\/workflows\/ci\.yml|\/actions\/runs\/[1-9]\d*(?:\/attempts\/[1-9]\d*(?:\/jobs\?per_page=100&page=(?:[1-9]|10))?)?|\/actions\/artifacts\/[1-9]\d*|\/pulls\/[1-9]\d*)$/;

export function createRouteEvidenceRequest(repository, token, fetchImpl = fetch) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || typeof token !== "string" || !token)
    throw new Error("route evidence refused: invalid GitHub configuration");

  return async (path) => {
    if (typeof path !== "string" || !endpoint.test(path))
      throw new Error("route evidence refused: invalid GitHub metadata path");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetchImpl(`https://api.github.com/repos/${repository}${path}`, {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": "2022-11-28",
        },
        redirect: "error",
        signal: controller.signal,
      });
      if (!response.ok) throw new Error("bad response");
      return await readGitHubMetadataJson(response.body);
    } catch {
      controller.abort();
      throw new Error("route evidence refused: GitHub metadata unavailable");
    } finally {
      clearTimeout(timer);
    }
  };
}
