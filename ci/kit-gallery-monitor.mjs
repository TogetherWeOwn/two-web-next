// Attach before navigation. These observations are inputs to the gallery job,
// not proof that all required states or performance gates were exercised.
export async function monitorGalleryPage(page) {
  const pageErrors = [];
  const consoleMessages = [];
  const failedRequests = [];
  const failedResponses = [];
  page.on("response", (response) => {
    if (response.status() >= 400)
      failedResponses.push({ url: response.url(), status: response.status() });
  });
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  page.on("console", (message) =>
    consoleMessages.push({ type: message.type(), text: message.text() }),
  );
  page.on("requestfailed", (request) =>
    failedRequests.push({
      url: request.url(),
      failure: request.failure()?.errorText ?? "unknown",
    }),
  );
  // CDP lives outside the document, so observations survive navigation and do not
  // depend on page JavaScript being enabled. This monitor requires Chromium.
  const violations = [];
  const session = await page.context().newCDPSession(page);
  let detached = false;
  session.on("Disconnected", () => {
    detached = true;
  });
  session.on("Audits.issueAdded", (event) => {
    const issue = event?.issue;
    if (!issue || typeof issue.code !== "string" || !issue.code) {
      violations.push({ error: "malformed audit issue" });
      return;
    }
    if (issue.code !== "ContentSecurityPolicyIssue") return;
    const details = issue.details?.contentSecurityPolicyIssueDetails;
    // Preserve malformed CSP issues as failures rather than silently ignoring them.
    violations.push(details ?? { error: "missing CSP issue details" });
  });
  await session.send("Audits.enable");

  return async function snapshot() {
    if (detached) throw new Error("CSP monitor disconnected");
    // Also detect a closed target or detached session before producing a receipt.
    await session.send("Runtime.evaluate", { expression: "true", returnByValue: true });
    return {
      "page-errors": { version: 1, monitoring: true, events: [...pageErrors] },
      "security-policy-violations": { version: 1, monitoring: true, events: [...violations] },
      console: { version: 1, monitoring: true, events: [...consoleMessages] },
      resources: {
        version: 1,
        monitoring: true,
        failedRequests: [...failedRequests],
        failedResponses: [...failedResponses],
      },
    };
  };
}
