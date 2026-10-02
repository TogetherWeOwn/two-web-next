import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

/**
 * TOG-9689 acceptance: no Livewire wire-protocol dependency remains.
 *
 * The islands re-spec replaces the protocol (POST /livewire/update, the
 * `wire:` morph directives, `wire:model` round trips) with explicit fetch
 * contracts in `src/islands/contracts.ts` + `public/islands/*.js`. This
 * test fails the build if any wire-protocol surface grows back — the
 * grep-verified half of the card's acceptance.
 */

const PROTOCOL_MARKERS = [
  "livewire/update",
  "wire:model",
  "wire:click",
  "wire:loading",
  "wire:target",
  "wire:key",
  "wire:init",
  "livewire.js",
  "@livewire",
  "Livewire::",
  "livewire/livewire",
];

const SCAN_DIRS = ["src", "test", "public"];

describe("no Livewire wire-protocol dependency", () => {
  it("finds no wire-protocol markers in shipped code, binders or tests", () => {
    const hits: string[] = [];
    for (const dir of SCAN_DIRS) {
      for (const marker of PROTOCOL_MARKERS) {
        let out = "";
        try {
          out = execFileSync(
            "grep",
            [
              "-r",
              "--include=*.ts",
              "--include=*.tsx",
              "--include=*.js",
              "-l",
              "--exclude=islands-no-livewire.test.ts",
              marker,
              dir,
            ],
            {
              encoding: "utf8",
            },
          ).trim();
        } catch {
          out = ""; // grep exits 1 when nothing matches.
        }
        if (out) hits.push(`${dir}: ${marker} in ${out.split("\n").join(", ")}`);
      }
    }
    expect(hits, "Livewire wire-protocol markers must not exist on Workers").toEqual([]);
  });

  it("documents the allowed legacy vocabulary", () => {
    // Words like "Livewire" may appear in comments/docs naming the migration
    // source (e.g. this file, contracts.ts headers). The protocol markers
    // above — not the word itself — are what this gate pins.
    expect(PROTOCOL_MARKERS.length).toBeGreaterThan(5);
  });
});
