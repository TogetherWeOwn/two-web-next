import { describe, expect, it } from "vitest";
import { parseInternalActionArgs } from "../bin/internal-action-args.mjs";

const inputs = ["--discord-id=900000000000009999", "--role-key=rocketleague", "--channel-key=qa"];

for (const smoke of [false, true]) {
  describe(`${smoke ? "smoke" : "drill"} discovery parser`, () => {
    it.each([[], ["--json"], ["--apply", "--dry-run"], ["--unknown=private-value"]])(
      "bare help overrides all other input: %j",
      (...args) => {
        const result = parseInternalActionArgs([...args, "--help", "--help"], smoke);
        expect(result).toEqual({ help: true, usage: expect.stringMatching(/^Usage:/) });
        expect(result.usage).toContain("docs/bot-probe-staging.md");
        expect(result.usage).not.toContain("private-value");
      },
    );

    it("explicit dry-run returns exactly the existing implicit-plan arguments", () => {
      const implicit = parseInternalActionArgs([...inputs, "--run-id=parser-1", "--json"], smoke);
      for (let position = 0; position <= inputs.length; position++) {
        const argv = [...inputs.slice(0, position), "--dry-run", ...inputs.slice(position)];
        expect(parseInternalActionArgs([...argv, "--run-id=parser-1", "--json"], smoke)).toEqual(
          implicit,
        );
      }
      expect(implicit).toMatchObject({ apply: false, json: true, runId: "parser-1" });
      expect(implicit).not.toHaveProperty("help");
    });

    it.each([
      ["--dry-run", "--apply"],
      ["--apply", "--dry-run"],
      ["--dry-run", "--dry-run"],
      ["--apply", "--apply"],
      ["--help=private-value"],
      ["--dry-run=private-value"],
      ["--apply=private-value"],
    ])("refuses ambiguous or valued modes: %j", (...mode) => {
      expect(() => parseInternalActionArgs([...inputs, ...mode], smoke)).toThrow(/^Usage:/);
      try {
        parseInternalActionArgs([...inputs, ...mode], smoke);
      } catch (error) {
        expect(String(error)).not.toContain("private-value");
      }
    });

    it("apply and JSON keep their existing argument shape", () => {
      expect(parseInternalActionArgs([...inputs, "--apply", "--json"], smoke)).toEqual({
        discordId: "900000000000009999",
        roleKey: "rocketleague",
        channelKey: "qa",
        eventKey: undefined,
        runId: undefined,
        announcementOnly: false,
        apply: true,
        json: true,
      });
    });
  });
}
