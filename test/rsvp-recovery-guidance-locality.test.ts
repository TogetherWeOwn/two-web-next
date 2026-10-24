// Helper regression: guidanceFor must pin each outcome to a single branch.
// A warning in an unrelated branch cannot satisfy a stop condition, and the
// Source-references section is never a branch. Both reviewer gutting mutants
// (paused, ended) must go red: gutting one branch's stop wording must leave
// its stop assertion unsatisfied, not borrow from another branch.
import { describe, expect, it } from "vitest";
import { guidanceFor, recoveryGuide } from "./helpers/rsvp-recovery-guide";

function gutSection(body: string, headingStart: string, guttedBody: string): string {
  const lines = body.split("\n");
  const start = lines.findIndex((line) => line.startsWith(headingStart));
  expect(start, `heading ${headingStart}`).toBeGreaterThanOrEqual(0);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^#{1,6} /.test(lines[i]!)) {
      end = i;
      break;
    }
  }
  const before = lines.slice(0, start + 1).join("\n");
  const after = lines.slice(end).join("\n");
  return `${before}\n\n${guttedBody}\n\n${after}`;
}

function pausedGutted(body: string): string {
  return gutSection(
    body,
    "### RSVPs are paused",
    "Check back later by reloading the event. Use only the controls the current page offers.",
  );
}

function endedGutted(body: string): string {
  return gutSection(
    body,
    "### This one has been and gone",
    "Check /events for another event or an approved replacement. If the date looks wrong, report through the approved path.",
  );
}

describe("rsvp recovery guidance branch locality", () => {
  it("paused gutting mutant goes red: no borrowing from Waitlisted or Source-references", () => {
    const { body } = recoveryGuide();
    const gutted = pausedGutted(body);
    const pausedBlock = gutted
      .split(/(?=^#{1,6} )/m)
      .find((block) => block.startsWith("### RSVPs are paused"))!;
    expect(pausedBlock).not.toMatch(/stop|moderator|support|do not|don't/i);
    const branch = guidanceFor(gutted, /paused/i);
    expect(branch).toMatch(/check back|reload|refresh/i);
    expect(branch).not.toMatch(/stop|moderator|support|do not|don't/i);
    expect(branch).not.toContain("Do not rely");
    expect(branch).not.toContain("bounded support");
  });

  it("ended gutting mutant goes red: no borrowing from Going, Waitlisted or Source-references", () => {
    const { body } = recoveryGuide();
    const gutted = endedGutted(body);
    const endedBlock = gutted
      .split(/(?=^#{1,6} )/m)
      .find((block) => block.startsWith("### This one has been and gone"))!;
    expect(endedBlock).not.toMatch(/stop|do not|don't|cannot|can't/i);
    const branch = guidanceFor(gutted, /\bended\b|been and gone|past event/i);
    expect(branch).toMatch(/events|replacement|another event/i);
    expect(branch).not.toMatch(/stop|do not|don't|cannot|can't/i);
    expect(branch).not.toContain("You have a seat");
    expect(branch).not.toContain("freezes promotion");
  });

  it("excludes Source-references from branch matching", () => {
    const { body } = recoveryGuide();
    expect(() => guidanceFor(body, /contracts-rsvp-button/)).toThrow(/recovery branch/);
  });

  it("requires exactly one matching branch for heading-based guides", () => {
    const { body } = recoveryGuide();
    expect(() => guidanceFor(body, /event/i)).toThrow(/recovery branch/);
  });

  it("bare ended outcome is ambiguous via attended; word-boundary version pins Ended only", () => {
    const { body } = recoveryGuide();
    expect(() => guidanceFor(body, /ended|been and gone|past event/i)).toThrow(/recovery branch/);
    const branch = guidanceFor(body, /\bended\b|been and gone|past event/i);
    expect(branch).toContain("been and gone");
    expect(branch).not.toContain("You have a seat");
    expect(branch).not.toContain("freezes promotion");
  });
});
