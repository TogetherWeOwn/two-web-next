// Test Author owned: stable JI-* cases. The Builder consumes this branch but
// returns corrections to the author; never weaken these tests to fit a build.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  backHref,
  compileInvestigationKit,
  decode,
  detailHref,
  investigationDocument,
  links,
  listPath,
  listState,
  plain,
  recorded,
  twins,
} from "./helpers/join-investigation";

let kit: Awaited<ReturnType<typeof compileInvestigationKit>>;
beforeAll(async () => {
  kit = await compileInvestigationKit();
});
afterAll(() => kit?.dispose());

const originating = "/admin/join-attempts?outcome=error&q=request%3Afixture-7&page=2";
const wanted = {
  origin: "https://example.test",
  path: "/admin/join-attempts",
  outcome: "error",
  q: "request:fixture-7",
  page: "2",
};

for (const twin of twins) {
  const render = (path: string, rows = [recorded]) => investigationDocument(kit, twin, path, rows);
  describe(`${twin}: join investigation acceptance`, () => {
    it("JI-01 detail carries structured outcome/exact-ID/page, not an arbitrary return URL", async () => {
      const page = await render(originating);
      expect(page.status).toBe(200);
      const href = detailHref(page.html);
      expect(href.startsWith(`${listPath}/7?`)).toBe(true);
      const url = new URL(href, wanted.origin);
      expect(url.origin).toBe(wanted.origin);
      expect(url.pathname).toBe(`${listPath}/7`);
      // Do not dictate field names or serialization order: discover the emitted
      // structured fields and use those same fields in the hostile-context tests.
      expect([...url.searchParams.values()]).toEqual(
        expect.arrayContaining(["2", "error", "request:fixture-7"]),
      );
      expect(url.searchParams.size).toBeGreaterThanOrEqual(3);
      expect(url.searchParams.size).toBeLessThanOrEqual(4); // Optional context-version marker.
      expect(new Set(url.searchParams.keys()).size).toBe(url.searchParams.size);
      expect(url.hash).toBe("");
      expect(href).not.toContain("return=");
    });

    it("JI-02 a fresh detail request returns to the same normalized filtered page", async () => {
      const list = await render(originating);
      const href = detailHref(list.html);
      const detail = await render(href);
      expect(detail.status).toBe(200);
      expect(listState(backHref(detail.html))).toEqual(wanted);
      // Independent request, no referer/cookie history or in-process prior view.
      const refreshed = await render(href);
      expect(listState(backHref(refreshed.html))).toEqual(wanted);
      for (const result of [list, detail, refreshed])
        expect(result.headers["cache-control"]).toBe("private, no-store");
    });

    it("JI-03 direct detail and free-form return URL attacks keep the unfiltered fallback", async () => {
      for (const value of [
        "https://evil.example/steal",
        "//evil.example/steal",
        "\\\\evil.example\\steal",
        "/admin/events",
      ]) {
        const query = new URLSearchParams({
          return: value,
          returnTo: value,
          next: value,
          back: value,
        });
        const detail = await render(`${listPath}/7?${query}`);
        expect(detail.status).toBe(200);
        expect(backHref(detail.html)).toBe(listPath);
      }
      expect(backHref((await render(`${listPath}/7`)).html)).toBe(listPath);
    });

    it("JI-04 rejects duplicate structured keys rather than choosing first/last", async () => {
      const href = detailHref((await render(originating)).html);
      const valid = new URL(href, wanted.origin);
      expect(valid.searchParams.size).toBeGreaterThanOrEqual(3);
      for (const [key, value] of valid.searchParams) {
        for (const duplicate of [value, "different"]) {
          const attack = new URL(valid);
          attack.searchParams.append(key, duplicate);
          expect(backHref((await render(attack.pathname + attack.search)).html)).toBe(listPath);
        }
      }
    });

    it("JI-05 rejects malformed and over-bound context without reflecting a hostile destination", async () => {
      const valid = new URL(detailHref((await render(originating)).html), wanted.origin);
      expect(valid.searchParams.size).toBeGreaterThanOrEqual(3);
      const pageKey = [...valid.searchParams].find(([, value]) => value === "2")![0];
      const qKey = [...valid.searchParams].find(([, value]) => value === "request:fixture-7")![0];
      const outcomeKey = [...valid.searchParams].find(([, value]) => value === "error")![0];
      const attacks: [string, string][] = [
        ...["0", "-2", "02", "1.5", "1e2", "NaN", "9007199254740993"].map(
          (value): [string, string] => [pageKey, value],
        ),
        [qKey, "x".repeat(129)],
        [outcomeKey, "界".repeat(8192)],
      ];
      for (const [key, value] of attacks) {
        const attack = new URL(valid);
        attack.searchParams.set(key, value);
        const detail = await render(attack.pathname + attack.search);
        expect(detail.status).toBe(200);
        expect(backHref(detail.html), `${key}: ${value.slice(0, 32)}`).toBe(listPath);
      }
      // Invalid percent encoding is tested at the wire boundary, not after URLSearchParams repairs it.
      const withoutQ = new URLSearchParams(valid.searchParams);
      withoutQ.delete(qKey);
      const malformed = `${valid.pathname}?${withoutQ}&${encodeURIComponent(qKey)}=%E0%A4%A`;
      expect(backHref((await render(malformed)).html)).toBe(listPath);
    });

    it("JI-06 normalizes NUL/whitespace and preserves an unknown exact outcome through the round trip", async () => {
      const outcome = 'future <outcome> & "literal"';
      const params = new URLSearchParams({
        outcome: `fu\0ture <outcome> & "literal"`,
        q: " \0request:fixture-7 \t",
        page: "2",
        ignored: "do-not-carry",
      });
      const list = await render(`${listPath}?${params}`);
      expect(list.status).toBe(200);
      expect(decode(list.html)).toContain(outcome);
      const detail = await render(detailHref(list.html));
      expect(listState(backHref(detail.html))).toEqual({ ...wanted, outcome });
      expect(backHref(detail.html)).not.toContain("ignored");
      const reads = list.statements.filter((s) => s.sql.includes('from "join_attempts"'));
      expect(reads).toHaveLength(1);
      expect(reads[0]!.params).toContain(outcome);
      expect(reads[0]!.params).toContain("request:fixture-7");
      expect(reads[0]!.params).toContain(100);
    });

    it("JI-07 list q/page policy stays intact: 128 is valid, 129 resets q, invalid page resets to first", async () => {
      for (const [q, page, wantQ, wantPage] of [
        ["x".repeat(128), "2", "x".repeat(128), "2"],
        ["x".repeat(129), "02", "", "1"],
      ]) {
        const list = await render(
          `${listPath}?${new URLSearchParams({ q: q!, page: page!, outcome: "error" })}`,
        );
        const detail = await render(detailHref(list.html));
        expect(listState(backHref(detail.html))).toEqual({ ...wanted, q: wantQ, page: wantPage });
      }
    });

    it("JI-08 bounds carried outcome context without silently changing unbounded list-filter policy", async () => {
      const outcome = "future-" + "界".repeat(8192);
      const list = await render(`${listPath}?${new URLSearchParams({ outcome, page: "2" })}`);
      expect(list.status).toBe(200);
      expect(decode(list.html)).toContain(outcome);
      const read = list.statements.find((s) => s.sql.includes('from "join_attempts"'))!;
      expect(read.params).toContain(outcome);
      const href = detailHref(list.html);
      // A gross oversized context must not be carried; the precise smaller cap
      // belongs in the Builder's design contract, not a new list-filter limit.
      expect(Buffer.byteLength(href, "utf8")).toBeLessThan(8192);
      expect(href).not.toContain(encodeURIComponent(outcome));
      expect(backHref((await render(href)).html)).toBe(listPath);
    });

    it.each([
      ["JI-09", "", /no.*(?:attempts|records|results).*(?:90|retention|window)/i, false, false],
      [
        "JI-10",
        "?outcome=future_outcome&q=exact-missing",
        /no.*match.*(?:filter|search)/i,
        true,
        false,
      ],
      [
        "JI-11",
        "?outcome=error&q=exact-missing&page=2",
        /no.*(?:rows|attempts|results).*page|page.*no.*(?:rows|attempts|results)/i,
        true,
        true,
      ],
      [
        "JI-12",
        "?page=3",
        /no.*(?:rows|attempts|results).*page|page.*no.*(?:rows|attempts|results)/i,
        false,
        true,
      ],
    ] as const)(
      "%s empty state has a truthful meaning and native recovery",
      async (_id, query, message, clear, first) => {
        const result = await render(listPath + query, []);
        expect(result.status).toBe(200);
        const cell = /data-testid="join-attempts-empty"[^>]*>([\s\S]*?)<\/td>/.exec(result.html);
        expect(plain(cell?.[1] ?? "")).toMatch(message);
        const recovery = links(result.html);
        const clearLink = recovery.find((a) => /clear filters/i.test(a.text));
        const firstLink = recovery.find((a) => /first page/i.test(a.text));
        if (clear) {
          expect(clearLink).toBeDefined();
          expect(listState(clearLink!.href)).toEqual({ ...wanted, outcome: "", q: "", page: "1" });
        }
        if (first) {
          expect(firstLink).toBeDefined();
          const filtered = query.includes("outcome=");
          expect(listState(firstLink!.href)).toEqual({
            ...wanted,
            outcome: filtered ? "error" : "",
            q: filtered ? "exact-missing" : "",
            page: "1",
          });
        }
        expect(
          result.statements.filter(
            (s) => /\bselect\b/i.test(s.sql) && !s.sql.startsWith("select set_config("),
          ),
        ).toHaveLength(1);
        expect(result.statements.some((s) => /count\s*\(/i.test(s.sql))).toBe(false);
        expect(plain(result.html)).not.toMatch(/\bPage \d+ of \d+|\b0 total\b/i);
      },
    );

    it.each([null, "", " \t "])(
      "JI-13 missing/blank source and request values plus null identity are explicit: %j",
      async (value) => {
        const row = { ...recorded, source: value, requestId: value, discordId: value };
        // Blank non-null Discord IDs are invalid owners, not unavailable
        // identities. Keep these successful reads null-owned; JI-20 separately
        // proves that blank owners still refuse rather than becoming anonymous.
        const safeRow = { ...row, discordId: null };
        const list = await render(listPath, [safeRow]);
        const cells = [...list.html.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map((m) =>
          plain(m[1]!),
        );
        expect(cells[1]).toMatch(/^(?:Not recorded|Not captured|Unavailable)$/i);
        expect(cells.slice(1, 4)).toEqual([cells[1], cells[1], cells[1]]);
        const detail = await render(`${listPath}/7`, [safeRow]);
        for (const field of ["Source", "Request ID", "Discord ID"]) {
          const valueHtml =
            new RegExp(`<dt>${field}<\\/dt>(?:\\s|<!--[\\s\\S]*?-->)*<dd>([\\s\\S]*?)<\\/dd>`).exec(
              detail.html,
            )?.[1] ?? "";
          expect(plain(valueHtml)).toBe(cells[1]);
        }
      },
    );

    it("JI-14 incomplete record copy does not imply anonymity, success, no attempt or ordinary sign-in", async () => {
      for (const path of [listPath, `${listPath}/7`]) {
        const result = await render(path, [
          { ...recorded, source: null, requestId: null, discordId: null },
        ]);
        const text = plain(result.html);
        expect(text).toMatch(
          /(?:missing|not recorded|unavailable).*?(?:not|neither|doesn.t|does not).*?(?:anon|identity)/i,
        );
        expect(text).toMatch(
          /(?:absence|missing|not recorded).*?(?:not|neither|doesn.t|does not).*?success/i,
        );
        expect(text).toMatch(
          /(?:absence|missing|not recorded).*?(?:not|neither|doesn.t|does not).*?(?:no|never|not|didn.t).*?attempt/i,
        );
        expect(text).toMatch(
          /(?:ordinary|normal|regular).*?sign.in.*?(?:not|doesn.t|does not)|(?:not|doesn.t|does not).*?(?:ordinary|normal|regular).*?sign.in/i,
        );
        expect(result.html.slice(result.html.indexOf("<main"))).not.toMatch(
          /<form[^>]*method="post"|\bdownload=|navigator\.clipboard|data-export/i,
        );
      }
    });

    it("JI-15 recorded diagnostics remain exact escaped text, not Not recorded", async () => {
      const value = '  <img src=x onerror="window.injected=1"> & recorded  ';
      const row = { ...recorded, outcome: value, source: value, requestId: value, discordId: null };
      for (const path of [listPath, `${listPath}/7`]) {
        const result = await render(path, [row]);
        const content = result.html.slice(result.html.indexOf("<main"));
        expect(content).not.toContain("<img src=x");
        const fields = [...content.matchAll(/<(?:td|dd)\b[^>]*>([\s\S]*?)<\/(?:td|dd)>/g)];
        expect(
          fields.filter((m) => decode(m[1]!.replace(/<!--[\s\S]*?-->/g, "")) === value),
        ).toHaveLength(path === listPath ? 2 : 3);
        expect(plain(content)).toContain('<img src=x onerror="window.injected=1"> & recorded');
      }
    });

    it("JI-16 the focused navigation path adds no telemetry, raw-query logs, counts or product writes", async () => {
      const logs = [
        vi.spyOn(console, "log"),
        vi.spyOn(console, "warn"),
        vi.spyOn(console, "error"),
      ];
      const fetch = vi
        .spyOn(globalThis, "fetch")
        .mockRejectedValue(new Error("No fixture network"));
      try {
        const list = await render(originating);
        const detail = await render(detailHref(list.html));
        const sql = [...list.statements, ...detail.statements].map((s) => s.sql).join("\n");
        expect(sql).not.toMatch(/\b(?:insert|update|delete)\b|count\s*\(/i);
        expect(fetch).not.toHaveBeenCalled();
        expect(logs.flatMap((spy) => spy.mock.calls)).toEqual([]);
      } finally {
        vi.restoreAllMocks();
      }
    });
  });
}

// Protected-route controls use the real Hono audit boundary and observer. Kit
// framework admission/hook parity remains covered by the neighboring Kit suites.
describe("join investigation protected-route controls", () => {
  it("JI-17 guests/members never read the record, including a context-bearing detail", async () => {
    for (const actor of ["guest", "member"] as const) {
      const result = await investigationDocument(
        kit,
        "Hono",
        `${listPath}/7?from_page=2&from_q=private`,
        [recorded],
        { actor },
      );
      expect(result.status).toBe(actor === "guest" ? 302 : 403);
      expect(result.statements).toEqual([]);
      expect(result.html).not.toContain(recorded.requestId);
    }
  });

  it("JI-18 lookahead owner is audited without a users join, even though it is not rendered", async () => {
    const rows = Array.from({ length: 101 }, (_, i) => ({
      ...recorded,
      id: i + 1,
      discordId: i === 100 ? "100000000000000777" : null,
    }));
    const result = await investigationDocument(kit, "Hono", originating, rows);
    expect(result.status).toBe(200);
    expect(result.html).not.toContain("100000000000000777");
    const audit = result.statements.filter((s) =>
      s.sql.startsWith('insert into "member_data_access_logs"'),
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]!.params).toContain('["100000000000000777"]');
    expect(result.statements.map((s) => s.sql).join("\n")).not.toMatch(/join "users"|count\s*\(/i);
  });

  it.each(["", " \t "])(
    "JI-20 blank non-null identity still refuses, never becomes anonymous: %j",
    async (discordId) => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        for (const path of [listPath, `${listPath}/7`]) {
          const result = await investigationDocument(kit, "Hono", path, [
            { ...recorded, discordId },
          ]);
          expect(result.status).toBe(503);
          expect(result.html).not.toContain(recorded.requestId);
          expect(
            result.statements.some((s) =>
              s.sql.startsWith('insert into "member_data_access_logs"'),
            ),
          ).toBe(false);
        }
      } finally {
        spy.mockRestore();
      }
    },
  );

  it("JI-19 an audit failure still refuses all trace contents and context-bearing navigation", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await investigationDocument(
        kit,
        "Hono",
        `${listPath}/7?from_page=2`,
        [{ ...recorded, discordId: "100000000000000777" }],
        { failAudit: true },
      );
      expect(result.status).toBe(503);
      expect(result.headers["cache-control"]).toMatch(/private/);
      expect(result.headers["cache-control"]).toMatch(/no-store/);
      expect(result.html).not.toContain(recorded.requestId);
      expect(result.html).not.toContain("100000000000000777");
      expect(backHref(result.html)).toBe("");
    } finally {
      spy.mockRestore();
    }
  });
});
