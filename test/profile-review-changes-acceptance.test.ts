// Independent profile-review contract. Render the real routes/twins; only
// sessions, the profile store and audit sink use the existing memory fixture.
import { parse, type DefaultTreeAdapterMap } from "parse5";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ORIGIN,
  OWNER,
  participationFixture,
  type Presentation,
} from "./helpers/profile-participation";

type Node = DefaultTreeAdapterMap["node"];
function descendants(node: Node): Node[] {
  return "childNodes" in node
    ? node.childNodes.flatMap((child) => [child, ...descendants(child)])
    : [];
}
function attr(node: Node, name: string) {
  return "attrs" in node ? node.attrs.find((item) => item.name === name)?.value : undefined;
}
function text(node: Node): string {
  return node.nodeName === "#text"
    ? (node as DefaultTreeAdapterMap["textNode"]).value
    : descendants(node)
        .filter((child) => child.nodeName === "#text")
        .map((child) => (child as DefaultTreeAdapterMap["textNode"]).value)
        .join("");
}
const byTestId = (nodes: Node[], id: string) =>
  nodes.filter((node) => attr(node, "data-testid") === id);
const named = (nodes: Node[], name: string) => nodes.filter((node) => attr(node, "name") === name);
const reviewControls = (nodes: Node[]) =>
  nodes.filter(
    (node) =>
      ["button", "summary"].includes(node.nodeName) && /^review changes$/i.test(text(node).trim()),
  );

afterEach(() => vi.unstubAllGlobals());

for (const renderer of ["Hono", "Kit"] as const) {
  describe(`${renderer}: profile review route/template acceptance`, () => {
    // Break: one twin omits the optional review or makes it a submit button.
    it("PRV-T01 exposes an optional inline review without adding a read or write", async () => {
      const fetch = vi.fn(() => {
        throw new Error("PRV_NETWORK_FORBIDDEN: use local fixture dependencies");
      });
      vi.stubGlobal("fetch", fetch);
      const f = await participationFixture("completed owner");
      const response = await f.request(renderer);
      expect(response.status).toBe(200);
      const nodes = descendants(parse(await response.text()));
      const editor = byTestId(nodes, "profile-edit")[0]!;
      const controls = reviewControls(descendants(editor));
      expect(
        controls,
        "PRV_REVIEW_MISSING: add the owner-only Review changes disclosure in this twin",
      ).toHaveLength(1);
      if (controls[0]!.nodeName === "button") expect(attr(controls[0]!, "type")).toBe("button");
      expect(byTestId(descendants(editor), "profile-review")).toHaveLength(1);
      expect(byTestId(nodes, "profile-save")).toHaveLength(1);
      expect(byTestId(nodes, "profile-cancel")).toHaveLength(1);
      expect(f.operations).toEqual([{ method: "find", args: [OWNER] }]);
      expect(f.statsReads).toEqual(renderer === "Kit" ? [OWNER] : []);
      expect(f.audit).toEqual([]);
      expect(fetch).not.toHaveBeenCalled();
    });

    // Controls stay independent of PRV-T01; missing review cannot mask these.
    it("PRV-C01 retains the complete native form and persisted baseline", async () => {
      const f = await participationFixture("completed owner");
      const response = await f.request(renderer);
      expect(response.status).toBe(200);
      const nodes = descendants(parse(await response.text()));
      const form = byTestId(nodes, "profile-form")[0]!;
      const fields = descendants(form);
      expect(attr(form, "method")).toBe("post");
      expect(attr(form, "action")).toBe(`/members/${OWNER}`);
      expect(attr(named(fields, "_method")[0]!, "value")).toBe("PATCH");
      expect(text(named(fields, "bio")[0]!)).toBe("A member who likes board games.");
      expect(text(named(fields, "games_text")[0]!)).toBe("Chess");
      expect(attr(named(fields, "timezone")[0]!, "value")).toBe("Europe/London");
      const optOut = named(fields, "leaderboard_opt_out");
      expect(optOut.map((node) => [attr(node, "type"), attr(node, "value")])).toEqual([
        ["hidden", "0"],
        ["checkbox", "1"],
      ]);
      expect(attr(byTestId(fields, "profile-save")[0]!, "type")).toBe("submit");
      expect(attr(byTestId(fields, "profile-cancel")[0]!, "type")).toBe("reset");
      const editor = byTestId(nodes, "profile-edit")[0]!;
      expect(attr(editor, "data-saved-bio")).toBe("A member who likes board games.");
      expect(attr(editor, "data-saved-leaderboard-opt-out")).toBe("1");
      expect(f.operations).toEqual([{ method: "find", args: [OWNER] }]);
    });

    it.each<Presentation>(["other member", "moderator"])(
      "PRV-C02 %s gets no editor, saved-baseline attributes or review data",
      async (presentation) => {
        const f = await participationFixture(presentation);
        const response = await f.request(renderer);
        expect(response.status).toBe(200);
        const nodes = descendants(parse(await response.text()));
        expect(byTestId(nodes, "profile-form")).toEqual([]);
        expect(byTestId(nodes, "profile-review")).toEqual([]);
        expect(reviewControls(nodes)).toEqual([]);
        expect(nodes.filter((node) => attr(node, "data-saved-bio") !== undefined)).toEqual([]);
        expect(named(nodes, "leaderboard_opt_out")).toEqual([]);
        expect(f.operations).toEqual([{ method: "find", args: [OWNER] }]);
        expect(f.audit).toHaveLength(1);
      },
    );

    it.each([
      { guest: true, status: 302 },
      { member: false, status: 403 },
    ])(
      "PRV-C03 admission $status still precedes profile access",
      async ({ status, ...options }) => {
        const f = await participationFixture("other member", options);
        const response = await f.request(renderer);
        expect(response.status).toBe(status);
        expect(await response.text()).not.toContain("A member who likes board games.");
        expect(f.operations).toEqual([]);
        expect(f.audit).toEqual([]);
      },
    );

    it("PRV-C04 native 422 keeps saved A separate from rejected B without a write", async () => {
      const f = await participationFixture("completed owner");
      const response = await f.request(renderer, `/members/${OWNER}`, {
        method: "POST",
        headers: { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          _method: "PATCH",
          bio: "B".repeat(1001),
          games_text: "Go",
          timezone: "UTC",
          leaderboard_opt_out: "0",
          website: "",
          formOpenedAt: String(Date.now() - 5000),
        }).toString(),
      });
      expect(response.status).toBe(422);
      const nodes = descendants(parse(await response.text()));
      const editor = byTestId(nodes, "profile-edit")[0]!;
      expect(text(named(descendants(editor), "bio")[0]!)).toBe("B".repeat(1001));
      expect(attr(editor, "data-saved-bio")).toBe("A member who likes board games.");
      expect(text(byTestId(nodes, "profile-bio")[0]!)).toBe("A member who likes board games.");
      expect(attr(editor, "data-saved-leaderboard-opt-out")).toBe("1");
      expect(f.operations).toEqual([{ method: "find", args: [OWNER] }]);
      expect(f.store.rows.get(OWNER)!.bio).toBe("A member who likes board games.");
    });
  });
}
