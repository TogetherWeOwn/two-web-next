import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import rawApp from "../src/index";
import app from "./app";
import { routeInventory } from "./helpers/route-inventory";
import {
  AUXILIARY_GETS,
  auditCoverage,
  publicRows,
  routeForAssertion,
  summarize,
  summarizeRun,
} from "../ci/check-hono-payloads.mjs";

const rows = publicRows();
const assertion = (group, title, status = "passed") => ({ ancestorTitles: [group], title, status });
const report = (assertions) => ({ success: true, testResults: [{ assertionResults: assertions }] });
const cleanAssertions = () => [
  ...rows.map((row) => assertion(`Hono GET ${row.route} anonymous payload`, "serves payload")),
  ...["no-member-data detector", "member-gated negative controls", "Hono payload coverage"].map(
    (group) => assertion(group, "control"),
  ),
  assertion("S7 agent-runnable gate", "calling-gate assertion", "pending"),
];

const FORBIDDEN_MEMBER_BYTES =
  /two_[A-Za-z0-9_-]{43}|[0-9]{17,20}|createdBy|created_by|discord_id|username/;

// Only the byte-identical official Logo 1 horizontal lockup may normalize its
// Illustrator gradient identifiers. Do not discard SVGs: an added title, text,
// attribute or comment invalidates this independent, fixed fingerprint and is
// scanned unchanged. The mobile icon needs no exception (no long numeric IDs).
const LOGO1_LOCKUP_SHA256 = "d75eaa7a7bea84fbc7964f68da74dc84564c59399793a2c3add1a6b01352579a";
function auxiliaryPayloadForInspection(body) {
  return body.replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/g, (svg) =>
    createHash("sha256").update(svg).digest("hex") === LOGO1_LOCKUP_SHA256
      ? svg.replace(/SVGID_[0-9]+_/g, "SVGID_static_")
      : svg,
  );
}

const auxiliaryEnv = {
  APP_URL: "https://next.example.test",
  SESSION_SECRET: "fixture-only-secret-with-at-least-thirty-two-characters",
  DISCORD_CLIENT_ID: "fixture-client",
  DISCORD_INVITE_URL: "https://discord.gg/invite",
};

describe("Hono payload coverage", () => {
  it("classifies every mounted GET and refuses unlisted or stale coverage", () => {
    const inventory = routeInventory(rawApp);
    expect(auditCoverage(inventory, rows)).toEqual({
      unlisted: [],
      stale: [],
      publicBecameGated: [],
    });
    expect(
      auditCoverage([...inventory, { method: "GET", path: "/new-public", auth: "public" }], rows)
        .unlisted,
    ).toEqual(["/new-public"]);
    expect(
      auditCoverage(
        [...inventory, { method: "GET", path: "/admin/new-public", auth: "moderator" }],
        rows,
      ).unlisted,
    ).toEqual(["/admin/new-public"]);
    expect(
      auditCoverage(
        inventory.filter((r) => r.path !== "/events"),
        rows,
      ).stale,
    ).toContain("/events");
    expect(auditCoverage(inventory, [...rows, { id: "new", route: "/missing" }]).stale).toContain(
      "/missing",
    );
    expect(
      auditCoverage(
        inventory.map((r) => (r.path === "/events" ? { ...r, auth: "member" } : r)),
        rows,
      ).publicBecameGated,
    ).toEqual(["/events"]);
  });

  it.each(AUXILIARY_GETS)("auxiliary GET %s returns only fixed non-member bytes", async (route) => {
    const memberReads = [];
    const forbiddenRead = new Proxy(
      {},
      {
        get(_target, key) {
          // Promise resolution checks for then; that is not a store read.
          if (key === "then") return undefined;
          return () => {
            memberReads.push(String(key));
            throw new Error("unexpected member read");
          };
        },
      },
    );
    const res = await app.request(
      `${route}?probe=leak-probe-member-zz9%40example.test`,
      {},
      {
        ...auxiliaryEnv,
        SESSION_STORE: forbiddenRead,
      },
    );
    expect(res.status).toBe(route === "/.well-known/security.txt" ? 200 : 404);
    const body = await res.text();
    expect(memberReads).toEqual([]);
    expect(auxiliaryPayloadForInspection(body)).not.toMatch(FORBIDDEN_MEMBER_BYTES);
    // security.txt intentionally contains the public disclosure mailbox. A blanket
    // email regex would forbid that RFC 9116 contact, not protect member data.
    expect(body).not.toContain("leak-probe-member-zz9@example.test");
    expect(body).not.toContain("leak-probe-\u202erebmem-zz9\u202c\u200f");
    expect(body).not.toContain("leak-probe-\u0301\ud83d\udc80\u6f22\u5b57-qq4");
  });

  it("normalizes only verified static art and still detects member IDs inside and outside SVG", async () => {
    const res = await app.request("/members", {}, auxiliaryEnv);
    expect(res.status).toBe(404);
    const body = await res.text();
    const art = body.match(/<svg\b[^>]*class="brand-lockup"[^>]*>[\s\S]*?<\/svg>/)?.[0];
    expect(art).toBeTruthy();
    expect(createHash("sha256").update(art).digest("hex")).toBe(LOGO1_LOCKUP_SHA256);
    expect(art).toMatch(FORBIDDEN_MEMBER_BYTES);
    const inspected = auxiliaryPayloadForInspection(body);
    expect(inspected).not.toMatch(FORBIDDEN_MEMBER_BYTES);
    expect(inspected).toContain("<title>Together We Own — horizontal lockup</title>");
    expect(inspected).toContain("<path");

    const memberId = "100000000000000001";
    const mutants = [
      body.replace("</body>", `<p>${memberId}</p></body>`),
      body.replace("</svg>", `<text>${memberId}</text></svg>`),
      body.replace(art, art.replace("<title>", `<title>${memberId}`)),
      body.replace('class="brand-lockup"', `class="brand-lockup" data-member="${memberId}"`),
      body.replace("</svg>", `<!-- ${memberId} --></svg>`),
      body.replace(/SVGID_[0-9]+_/, `SVGID_${memberId}_`),
      body.replace("</body>", `<svg><title>${memberId}</title></svg></body>`),
      body.replace("</body>", `<p>SVGID_${memberId}_</p></body>`),
    ];
    for (const mutant of mutants) {
      expect(mutant).not.toBe(body);
      const checked = auxiliaryPayloadForInspection(mutant);
      expect(checked).toContain(memberId);
      // Require the planted ID itself to survive, not merely a coincidental
      // match on an original gradient ID in an invalidated lockup.
      expect(checked.match(FORBIDDEN_MEMBER_BYTES)).not.toBeNull();
    }
    const changedArt = art.replace("</svg>", `<text>${memberId}</text></svg>`);
    expect(auxiliaryPayloadForInspection(changedArt)).toBe(changedArt);
    for (const marker of [
      "createdBy",
      "created_by",
      "discord_id",
      "username",
      `two_${"a".repeat(43)}`,
    ]) {
      expect(auxiliaryPayloadForInspection(`${body}<p>${marker}</p>`)).toMatch(
        FORBIDDEN_MEMBER_BYTES,
      );
    }
  });

  it("maps every public check without prefix collisions, including signals", () => {
    expect(summarize(rows, report(cleanAssertions())).ok).toBe(true);
    expect(
      routeForAssertion(rows, assertion("Hono GET /events anonymous payload", "serves rows")),
    ).toBe("hono-payload:events");
    expect(
      routeForAssertion(
        rows,
        assertion("Hono GET /hotzones/:signal anonymous payloads", "voice serves estimate"),
      ),
    ).toBe("hono-payload:hotzones-voice");
    expect(
      routeForAssertion(
        rows,
        assertion(
          "Hono public JSON API anonymous payloads",
          "GET /api/public/events/:key serves DTO",
        ),
      ),
    ).toBe("hono-payload:api-events-item");
  });

  it("fails closed on missing, failed, skipped, unmapped or non-successful results", () => {
    const clean = cleanAssertions();
    expect(summarize(rows, report([])).ok).toBe(false);
    expect(summarize(rows, report(clean.slice(1))).checks[0].status).toBe("vacuous");
    for (const status of ["failed", "pending", "skipped", "todo"]) {
      expect(summarize(rows, report([{ ...clean[0], status }, ...clean.slice(1)])).ok).toBe(false);
    }
    expect(summarize(rows, report([...clean, assertion("new group", "unmapped")])).ok).toBe(false);
    expect(summarize(rows, { ...report(clean), success: false }).ok).toBe(false);
    expect(summarize(rows, report(clean.slice(0, -1))).ok).toBe(false);
    expect(routeForAssertion(rows, assertion("Hono debug", "GET /events debug"))).toBe(null);
    for (const run of [
      { status: 1 },
      { status: null, signal: "SIGTERM" },
      { status: 0, error: new Error("spawn failure") },
    ]) {
      expect(summarizeRun(rows, run, report(clean)).ok).toBe(false);
    }
    expect(summarizeRun(rows, { status: null }, {}).checks).toHaveLength(rows.length);
    expect(
      summarize(
        rows,
        report(clean.filter((a) => a.ancestorTitles[0] !== "member-gated negative controls")),
      ).ok,
    ).toBe(false);
  });

  it("rejects malformed or executable route tables without evaluating them", () => {
    for (const source of [
      "const PUBLIC_HONO_GETS = []",
      "const PUBLIC_HONO_GETS = loadRoutes()",
      'const PUBLIC_HONO_GETS = [{id: "hono-payload:x", method: "GET", route: "/", kind: "payload", extra: run()}]',
      'const PUBLIC_HONO_GETS = [{id: "x", method: "GET", route: "/", kind: "payload"}]',
    ])
      expect(() => publicRows(source)).toThrow();
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
  });
});
