// Breaks caught: lost event-editor recovery after a genuine refusal; an invented
// event-deletion claim; conflating empty pages with empty data; raw-query replay;
// added reads/mutations; lost native keyboard recovery. Oracles come from the spec,
// not production URL/copy builders. All data is synthetic; no database is opened.
import { parse } from "parse5";
import { beforeAll, describe, expect, it, vi } from "vitest";
import * as eventStore from "../src/admin/store";
import { ValidationError } from "../src/admin/validation";
import {
  compileAdminRetryKit,
  retryPage,
  type AdminRetryKit,
} from "./helpers/admin-read-retry-acceptance";
import {
  activityRecovery,
  activityRow,
  honoRecovery,
  recoveryDb,
  recoveryEvent,
  recoveryOrigin,
  refusedEvent,
} from "./helpers/admin-safe-recovery-acceptance";

type Node = {
  tagName?: string;
  nodeName: string;
  value?: string;
  attrs?: { name: string; value: string }[];
  childNodes?: Node[];
};
function elements(node: Node, predicate: (node: Node) => boolean): Node[] {
  return [
    ...(predicate(node) ? [node] : []),
    ...(node.childNodes ?? []).flatMap((child) => elements(child, predicate)),
  ];
}
const attr = (node: Node, name: string) => node.attrs?.find((a) => a.name === name)?.value;
const text = (node: Node): string =>
  node.nodeName === "#text" ? (node.value ?? "") : (node.childNodes ?? []).map(text).join("");
function content(html: string) {
  const doc = parse(html) as Node;
  return elements(doc, (n) => n.tagName === "main")[0] ?? doc;
}
function links(html: string) {
  return elements(content(html), (n) => n.tagName === "a").map((node) => ({
    href: attr(node, "href"),
    name: (attr(node, "aria-label") ?? text(node)).trim(),
  }));
}
function emptyText(html: string) {
  const cells = elements(content(html), (n) => attr(n, "data-testid") === "activity-log-empty");
  expect(cells).toHaveLength(1);
  return text(cells[0]!);
}
function namedLink(html: string, name: RegExp) {
  const found = links(html).filter((a) => name.test(a.name));
  expect(found, `native recovery link ${name}`).toHaveLength(1);
  const link = found[0]!;
  expect(link.href).toMatch(/^\/admin(?:\/|\?|$)/);
  return new URL(link.href!, recoveryOrigin);
}
function privateRead(result: Awaited<ReturnType<typeof activityRecovery>>, offset = 0) {
  expect(result.status).toBe(200);
  expect(result.headers.get("cache-control")).toMatch(/private/);
  expect(result.headers.get("cache-control")).toMatch(/no-store/);
  expect(result.probe.reads).toHaveLength(1);
  expect(result.probe.reads[0]!.sql).toMatch(/from "activity_log"/);
  const query = result.probe.reads[0]!;
  const bound = (clause: string, absent: number) => {
    const match = query.sql.match(new RegExp(`\\b${clause}\\s+(?:\\$(\\d+)|(\\d+))`, "i"));
    return match ? (match[1] ? query.params[Number(match[1]) - 1] : Number(match[2])) : absent;
  };
  expect(bound("limit", 0)).toBe(51);
  expect(bound("offset", 0)).toBe(offset);
  expect(result.probe.reads[0]!.sql).not.toMatch(/count\s*\(|"properties"/i);
  expect(result.probe.writes).toEqual([]);
}
let kit: AdminRetryKit;
beforeAll(async () => {
  kit = await compileAdminRetryKit();
});

describe("Hono refused transition recovery", () => {
  for (const [action, status, explanation] of [
    ["publish", "cancelled", /cancelled/i],
    ["cancel", "past", /Only a draft or a published event can be cancelled/i],
    ["rsvp-pause", "draft", /Only published events/],
    ["rsvp-reopen", "draft", /Only published events/],
  ] as const) {
    it(`${action} keeps its real 422 explanation and offers only safe GET recovery`, async () => {
      const row = refusedEvent({ status });
      const result = await honoRecovery(
        `/admin/events/${recoveryEvent}/${action}?next=https://evil.example/`,
        recoveryDb([row]),
        "POST",
      );
      expect(result.status).toBe(422);
      expect(text(content(result.html))).toMatch(explanation);
      expect(result.probe.writes).toEqual([]);
      expect(result.probe.audits).toEqual([]);
      expect(row.status).toBe(status);
      expect(elements(content(result.html), (n) => n.tagName === "form")).toEqual([]);
      expect(links(result.html).some((a) => a.href === "/admin")).toBe(true);
      expect(
        links(result.html).filter((a) => a.href === `/admin/events/${recoveryEvent}`),
      ).toHaveLength(1);
      expect(links(result.html).filter((a) => a.href === "/admin/events")).toHaveLength(1);
      expect(
        links(result.html).every((a) => !/publish|cancel|rsvp-|evil\.example/.test(a.href ?? "")),
      ).toBe(true);
    });
  }

  it("escapes an unsafe non-field explanation without treating it as recovery markup", async () => {
    const detail = '<script>PRIVATE_REFUSAL</script> & "changed"';
    const injected = vi
      .spyOn(eventStore, "transitionEvent")
      .mockRejectedValueOnce(new ValidationError({ status: detail }));
    try {
      const result = await honoRecovery(
        `/admin/events/${recoveryEvent}/publish`,
        recoveryDb(),
        "POST",
      );
      expect(result.status).toBe(422);
      expect(text(content(result.html))).toContain(detail);
      expect(elements(content(result.html), (n) => n.tagName === "script")).toEqual([]);
      expect(result.html).not.toContain("<script>PRIVATE_REFUSAL</script>");
    } finally {
      injected.mockRestore();
    }
  });

  it("CONTROL: location errors still redisplay the editable field and retained values", async () => {
    const row = refusedEvent({ status: "draft", location: "", title: "Retained draft title" });
    const result = await honoRecovery(
      `/admin/events/${recoveryEvent}/publish`,
      recoveryDb([row]),
      "POST",
    );
    expect(result.status).toBe(422);
    expect(result.html).toContain("Add a location before publishing.");
    expect(
      elements(
        content(result.html),
        (n) => n.tagName === "input" && attr(n, "name") === "title",
      ).map((n) => attr(n, "value")),
    ).toEqual(["Retained draft title"]);
    expect(
      elements(
        content(result.html),
        (n) => n.tagName === "input" && attr(n, "name") === "location",
      ),
    ).toHaveLength(1);
    expect(result.probe.writes).toEqual([]);
  });

  it("CONTROL: invalid keys and unauthorized requests cannot acquire event recovery or read data", async () => {
    for (const admission of ["guest", "member"] as const) {
      const result = await honoRecovery(
        `/admin/events/${recoveryEvent}/publish`,
        recoveryDb(),
        "POST",
        admission,
      );
      expect(result.status).toBe(admission === "guest" ? 303 : 403);
      expect(result.probe.reads).toEqual([]);
      expect(result.probe.writes).toEqual([]);
    }
    const invalid = await honoRecovery("/admin/events/%3Cscript%3E/publish", recoveryDb(), "POST");
    expect(invalid.status).toBe(404);
    expect(invalid.probe.reads).toEqual([]);
    expect(invalid.html).not.toContain('href="/admin/events/&lt;script');
  });
});

describe("executed Kit admin error boundary", () => {
  it("missing event does not invent deletion while keeping native family/dashboard links", () => {
    const rendered = kit.render(
      "admin",
      retryPage(404, `/admin/events/${recoveryEvent}`, "/admin/events/[key]"),
    );
    const body = text(content(rendered.body));
    expect(body).toMatch(/no event with that key/i);
    expect(body).not.toMatch(/delet|removed/i);
    expect(links(rendered.body)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ href: "/admin/events", name: "Back to events" }),
        expect.objectContaining({ href: "/admin", name: "Back to the dashboard" }),
      ]),
    );
    expect(body).not.toContain("private-read-failure");
    expect(rendered.head).toMatch(/noindex/);
  });

  it("CONTROL: featured deletion wording remains accurate and retains its own family link", () => {
    const rendered = kit.render(
      "admin",
      retryPage(404, "/admin/featured/9", "/admin/featured/[id]"),
    );
    expect(text(content(rendered.body))).toMatch(/may have been deleted/i);
    expect(links(rendered.body)).toContainEqual({
      href: "/admin/featured",
      name: "Back to featured",
    });
    expect(links(rendered.body).some((a) => /retry/i.test(a.name))).toBe(false);
  });

  it("CONTROL: activity outage is not empty and retains its normalized read retry without exception echo", () => {
    const rendered = kit.render(
      "admin",
      retryPage(503, "/admin/activity-log?page=8&subject=Event&causer=42", "/admin/activity-log"),
    );
    const body = text(content(rendered.body));
    expect(body).toMatch(/temporarily unavailable/i);
    expect(body).not.toMatch(/No activity|private-read-failure/);
    expect(namedLink(rendered.body, /Retry loading/i).pathname).toBe("/admin/activity-log");
  });
});

for (const renderer of ["Hono", "Kit"] as const) {
  describe(`${renderer} activity recovery through actual reader and rendered page`, () => {
    it("CONTROL: a genuinely empty first page is not a filter miss or an invitation to clear nothing", async () => {
      const result = await activityRecovery(renderer);
      privateRead(result);
      expect(emptyText(result.html)).toMatch(/No activity yet/i);
      expect(
        links(result.html).some((a) => /Clear filters|First page of these results/i.test(a.name)),
      ).toBe(false);
      expect(result.probe.audits).toEqual([]);
    });

    it("CONTROL: normalized-away filters do not create a misleading clear action", async () => {
      const result = await activityRecovery(
        renderer,
        `?subject=%00%20&causer=${"x".repeat(129)}&page=0&next=https://evil.example/`,
      );
      privateRead(result);
      expect(emptyText(result.html)).toMatch(/No activity yet/i);
      expect(
        links(result.html).some((a) => /Clear filters|First page of these results/i.test(a.name)),
      ).toBe(false);
      expect(JSON.stringify(result.probe.reads[0]!.params)).not.toContain("x".repeat(129));
    });

    it("a first-page filter miss offers native Clear filters, not a global-empty claim", async () => {
      const result = await activityRecovery(renderer, "?subject=Event%20%26%20Alpha&causer=42");
      privateRead(result);
      expect(result.probe.reads[0]!.params).toEqual(
        expect.arrayContaining(["%Event & Alpha%", "%42%"]),
      );
      expect(emptyText(result.html)).toMatch(/No activity matches these filters/i);
      const clear = namedLink(result.html, /^Clear filters$/i);
      expect(clear.pathname).toBe("/admin/activity-log");
      expect(clear.searchParams.has("subject")).toBe(false);
      expect(clear.searchParams.has("causer")).toBe(false);
      expect([null, "1"]).toContain(clear.searchParams.get("page"));
      expect(links(result.html).some((a) => /First page of these results/i.test(a.name))).toBe(
        false,
      );
    });

    for (const filtered of [false, true]) {
      it(`${filtered ? "filtered" : "unfiltered"} empty later page names the page and returns directly to its first results`, async () => {
        const search = `?page=9${filtered ? "&subject=%20Event%20%26%20Alpha%00%20&causer=%2042%2Flegacy%20" : ""}&next=https://evil.example/`;
        const result = await activityRecovery(renderer, search);
        privateRead(result, 400);
        if (filtered)
          expect(result.probe.reads[0]!.params).toEqual(
            expect.arrayContaining(["%Event & Alpha%", "%42/legacy%"]),
          );
        expect(emptyText(result.html)).toMatch(/page/i);
        expect(emptyText(result.html)).not.toMatch(
          /^\s*(?:No activity yet|No activity matches these filters)\.?\s*$/i,
        );
        const first = namedLink(result.html, /^First page of these results$/i);
        expect(first.pathname).toBe("/admin/activity-log");
        expect([null, "1"]).toContain(first.searchParams.get("page"));
        expect(first.searchParams.get("subject")).toBe(filtered ? "Event & Alpha" : null);
        expect(first.searchParams.get("causer")).toBe(filtered ? "42/legacy" : null);
        expect(first.searchParams.has("next")).toBe(false);
        expect(links(result.html).some((a) => /^Clear filters$/i.test(a.name))).toBe(filtered);
      });
    }

    it("CONTROL: populated rows retain bounded paging, audit attribution and projection privacy", async () => {
      const rows = Array.from({ length: 51 }, (_, index) => ({
        ...activityRow,
        id: index + 1,
        properties: { private: "PRIVATE_BEFORE_AFTER" },
      }));
      const result = await activityRecovery(
        renderer,
        "?page=2&subject=Event&causer=100000000000000111",
        rows,
      );
      privateRead(result, 50);
      expect(result.probe.reads[0]!.params).toEqual(
        expect.arrayContaining(["%Event%", "%100000000000000111%"]),
      );
      expect(result.html).not.toContain("PRIVATE_BEFORE_AFTER");
      expect(text(content(result.html))).toContain("Recorded fixture change <not markup>");
      expect(elements(content(result.html), (n) => n.tagName === "time")).toHaveLength(50);
      const next = namedLink(result.html, /^Next$/);
      expect(next.searchParams.get("page")).toBe("3");
      expect(next.searchParams.get("subject")).toBe("Event");
      expect(next.searchParams.get("causer")).toBe("100000000000000111");
      if (renderer === "Hono") expect(result.probe.audits).toHaveLength(1);
      // Kit's outer resolve boundary, not the page load, owns the access audit;
      // existing integration tests exercise that boundary. Do not invent one here.
      expect(result.html).not.toContain('data-testid="activity-log-empty"');
    });

    it("CONTROL: database failure stays 503/private/no-store, never a successful empty table", async () => {
      const result = await activityRecovery(renderer, "?subject=Event&page=9", [], true);
      expect(result.status).toBe(503);
      expect(result.headers.get("cache-control")).toMatch(/private/);
      expect(result.headers.get("cache-control")).toMatch(/no-store/);
      expect(result.html).not.toMatch(/No activity|PRIVATE_DATABASE_EXCEPTION/);
      expect(result.probe.reads).toHaveLength(1);
      expect(result.probe.writes).toEqual([]);
      expect(result.probe.audits).toEqual([]);
    });
  });
}
