import postgres from "postgres";
import { afterEach, expect, it, vi } from "vitest";
import { main } from "../bin/import/audit.mjs";

vi.mock("postgres", () => ({ default: vi.fn() }));
afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(postgres).mockReset();
});

for (const dryRun of [true, false]) {
  for (const side of ["source", "destination"]) {
    for (const [label, result] of [
      ["denied", [{ acquired: false }]],
      ["incomplete", []],
      [
        "driver error",
        Object.assign(
          new Error("synthetic-row postgres://synthetic:synthetic-password@alias.invalid/db"),
          {
            code: "42501",
            query: "synthetic-row",
            detail: "synthetic-password",
          },
        ),
      ],
    ]) {
      it(`CLI fails closed without credential/row output on ${side} ${label} (${dryRun ? "preview" : "apply"})`, async () => {
        const clients = ["source", "destination"].map((name) => {
          const transaction = async (strings) => {
            if (!strings.join("").includes("pg_try_advisory_xact_lock")) return [];
            if (name !== side) return [{ acquired: true }];
            if (result instanceof Error) throw result;
            return result;
          };
          transaction.unsafe = vi.fn(() => {
            throw new Error("unexpected_data_access");
          });
          return {
            begin: async (_options, callback) => callback(transaction),
            end: vi.fn(async () => {}),
            transaction,
          };
        });
        vi.mocked(postgres).mockReturnValueOnce(clients[0]).mockReturnValueOnce(clients[1]);
        const stdout = vi.spyOn(console, "log").mockImplementation(() => {});
        const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
        expect(
          await main(dryRun ? [] : ["--apply"], {
            LEGACY_DATABASE_URL:
              "postgres://synthetic:synthetic-password@source.invalid/same_named_db",
            DATABASE_URL: "postgresql://synthetic:synthetic-password@alias.invalid/same_named_db",
          }),
        ).toBe(1);
        expect(stdout).not.toHaveBeenCalled();
        expect(stderr.mock.calls).toEqual([
          [
            `Audit import failed${result instanceof Error ? " (SQLSTATE 42501)" : ""}; no row data or connection details logged.`,
          ],
        ]);
        for (const client of clients) {
          expect(client.transaction.unsafe).not.toHaveBeenCalled();
          expect(client.end).toHaveBeenCalledExactlyOnceWith({ timeout: 5 });
        }
      });
    }
  }
}
