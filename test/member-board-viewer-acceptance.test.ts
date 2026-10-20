// Protected acceptance tests. Builder consumes these unmodified with the fixture
// and visual spec. Removing/duplicating the viewer mark must fail these controls;
// visible marking and sticky positioning are exercised by the paired browser spec.
import { beforeAll, describe, expect, it } from "vitest";
import {
  prepareMemberBoardFixtures,
  renderMemberBoard,
  VIEWER,
} from "./fixtures/member-board-viewer";

beforeAll(prepareMemberBoardFixtures, 120000);

for (const twin of ["hono", "kit"] as const) {
  for (const scope of ["overall", "relative"] as const) {
    describe(`${twin} ${scope} member-board viewer acceptance`, () => {
      it("marks exactly the viewer row without changing its absolute rank", () => {
        const html = renderMemberBoard(twin, scope);
        expect(html).toContain('href="/schedule-theme.css"');
        const rows = [...html.matchAll(/<tr\b[^>]*>[\s\S]*?<\/tr>/g)].map((match) => match[0]);
        const marked = rows.filter((row) => /^<tr\b[^>]*aria-current="true"/.test(row));
        expect(marked).toHaveLength(1);
        expect(marked[0]).toContain(VIEWER);
        expect(marked[0]).toMatch(scope === "overall" ? />9<\// : />41<\//);
        expect(rows.filter((row) => row.includes("Fixture member"))).toHaveLength(
          scope === "overall" ? 59 : 10,
        );
      });

      it("does not mark a namesake when the viewer has no ranked row", () => {
        const html = renderMemberBoard(twin, scope, false);
        expect(html).toContain(VIEWER);
        expect(html).not.toMatch(/<tr\b[^>]*aria-current="true"/);
      });

      it("does not invent a viewer row for an empty board", () => {
        expect(renderMemberBoard(twin, scope, false, true)).not.toMatch(
          /<tr\b[^>]*aria-current="true"/,
        );
      });
    });
  }
}
