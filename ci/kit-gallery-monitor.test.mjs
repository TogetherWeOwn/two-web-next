import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { monitorGalleryPage } from "./kit-gallery-monitor.mjs";

class Session extends EventEmitter {
  commands = [];
  async send(method) {
    this.commands.push(method);
  }
}

class Page extends EventEmitter {
  session = new Session();
  context() {
    return { newCDPSession: async () => this.session };
  }
}

test("installs monitoring before navigation and records browser observations", async () => {
  const page = new Page();
  const snapshot = await monitorGalleryPage(page);
  assert.deepEqual(page.session.commands, ["Audits.enable"]);
  assert.equal(page.listenerCount("pageerror"), 1);
  assert.equal(page.listenerCount("console"), 1);
  assert.equal(page.listenerCount("requestfailed"), 1);
  assert.equal(page.listenerCount("response"), 1);

  page.emit("pageerror", new Error("hydration failed"));
  page.emit("console", { type: () => "error", text: () => "broken" });
  page.emit("requestfailed", {
    url: () => "http://localhost/a.css",
    failure: () => ({ errorText: "failed" }),
  });
  page.emit("response", { url: () => "http://localhost/missing.css", status: () => 404 });
  page.emit("response", { url: () => "http://localhost/ok.css", status: () => 200 });
  const details = { violatedDirective: "script-src", blockedURL: "inline" };
  page.session.emit("Audits.issueAdded", {
    issue: {
      code: "ContentSecurityPolicyIssue",
      details: { contentSecurityPolicyIssueDetails: details },
    },
  });
  // An unrelated issue and a navigation do not clear earlier observations.
  page.session.emit("Audits.issueAdded", { issue: { code: "OtherIssue" } });
  page.emit("framenavigated");
  page.session.emit("Audits.issueAdded", {
    issue: { code: "ContentSecurityPolicyIssue", details: {} },
  });
  const report = await snapshot();
  assert.match(report["page-errors"].events[0], /hydration failed/);
  assert.deepEqual(report["security-policy-violations"].events, [
    details,
    { error: "missing CSP issue details" },
  ]);
  assert.equal(report.console.events[0].type, "error");
  assert.equal(report.resources.failedRequests[0].failure, "failed");
  assert.deepEqual(report.resources.failedResponses, [
    { url: "http://localhost/missing.css", status: 404 },
  ]);
  page.session.emit("Disconnected");
  await assert.rejects(snapshot(), /CSP monitor disconnected/);
});

test("malformed audit events fail closed instead of throwing or disappearing", async () => {
  const page = new Page();
  const snapshot = await monitorGalleryPage(page);
  for (const event of [undefined, {}, { issue: {} }, { issue: { code: "" } }]) {
    page.session.emit("Audits.issueAdded", event);
  }
  const report = await snapshot();
  assert.deepEqual(
    report["security-policy-violations"].events,
    Array.from({ length: 4 }, () => ({ error: "malformed audit issue" })),
  );
});

test("fails setup or snapshot when the CDP session cannot be used", async () => {
  const page = new Page();
  page.session.send = async () => {
    throw new Error("CDP unavailable");
  };
  await assert.rejects(monitorGalleryPage(page), /CDP unavailable/);
  const usable = new Page();
  const snapshot = await monitorGalleryPage(usable);
  usable.session.send = async () => {
    throw new Error("target closed");
  };
  await assert.rejects(snapshot(), /target closed/);
});
