import { readRouteEvidenceArtifact } from "./route-evidence-artifact-bytes.mjs";

const downloadTimeoutMs = 10_000;

// Callers must bind the repository, artifact ID, and expected digest to trusted
// inputs before downloading. This helper does not authenticate producer identity.
export function createRouteEvidenceDownload(repository, token, fetchImpl = fetch) {
  if (
    typeof repository !== "string" ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) ||
    repository.split("/").some((segment) => segment === "." || segment === "..") ||
    typeof token !== "string" ||
    !token
  )
    throw new Error("route evidence refused: invalid download configuration");

  return async (artifactId, digest) => {
    if (!Number.isSafeInteger(artifactId) || artifactId < 1)
      throw new Error("route evidence refused: invalid artifact ID");
    const controller = new AbortController();
    const deadline = performance.now() + downloadTimeoutMs;
    const expiry = Promise.withResolvers();
    const deadlineError = new Error("download deadline exceeded");
    const timer = setTimeout(() => {
      expiry.reject(deadlineError);
      controller.abort();
    }, downloadTimeoutMs);
    const checkDeadline = () => {
      controller.signal.throwIfAborted();
      if (performance.now() >= deadline) throw deadlineError;
    };

    async function downloadArtifact() {
      const response = await fetchImpl(
        `https://api.github.com/repos/${repository}/actions/artifacts/${artifactId}/zip`,
        {
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${token}`,
            "X-GitHub-Api-Version": "2022-11-28",
          },
          redirect: "manual",
          signal: controller.signal,
        },
      );
      checkDeadline();
      if (response.status !== 302) throw new Error("invalid redirect");
      const url = new URL(response.headers.get("location"));
      // Refuse unexpected hosts; live provider compatibility is not established.
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.port ||
        !/^[a-z0-9-]+\.blob\.core\.windows\.net$/.test(url.hostname)
      )
        throw new Error("invalid storage host");
      const archive = await fetchImpl(url.href, {
        credentials: "omit",
        redirect: "error",
        signal: controller.signal,
      });
      checkDeadline();
      return readRouteEvidenceArtifact(archive, digest, checkDeadline);
    }

    try {
      // Refuse even if a pending fetch or body read never observes abort.
      const files = await Promise.race([expiry.promise, downloadArtifact()]);
      // Bounded synchronous extraction can finish before a queued timer fires.
      checkDeadline();
      return files;
    } catch {
      throw new Error("route evidence refused: artifact download unavailable");
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  };
}
