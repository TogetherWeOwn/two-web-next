// Evidence capture, not acceptance: the native Hono admin event edit form with
// multiline and boundary cases at desktop and mobile. The browser's own Save
// click submits the form; no request is intercepted, fulfilled or modified.
//
//   EVENT_FORM_CAPTURE_DIR=<dir> REQUESTED_SHA=<40-hex> [EVENT_FORM_CAPTURE_PHASE=base|head] \
//     npx playwright test -c playwright.event-form-capture.config.ts
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import postgres from "postgres";
import { requireTestDatabase } from "./ci-only.mjs";
import { expect, qaLogin, test } from "./fixtures";

const output = process.env.EVENT_FORM_CAPTURE_DIR;
const phase = process.env.EVENT_FORM_CAPTURE_PHASE ?? "unspecified";
if (!output) throw new Error("Event form capture requires EVENT_FORM_CAPTURE_DIR");
if (!/^[a-z0-9-]+$/.test(phase)) throw new Error("EVENT_FORM_CAPTURE_PHASE must be a slug");
const directory = path.resolve(output);
const requestedSha = process.env.REQUESTED_SHA ?? "";
if (!/^[0-9a-f]{40}$/.test(requestedSha)) throw new Error("REQUESTED_SHA must be a 40-hex SHA");
// Recorded separately: what was asked for versus what is actually checked out.
const observedHead = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
if (observedHead !== requestedSha) throw new Error("Checkout does not match requested SHA");

const viewports = [
  { name: "desktop", width: 1280, height: 800 },
  { name: "mobile", width: 390, height: 844 },
];
// Synthetic, owned drafts; keys are unique per case and viewport.
const keyFor = (caseIndex: number, viewportIndex: number) =>
  `01KEVTFRMC${caseIndex}${viewportIndex}`.padEnd(26, "0");
const seed: Record<string, string | number> = {
  title: "E2E form capture night",
  game: "Synthetic Chess",
  description: "Seed description",
  accessibility_notes: "Seed access note",
  organizer_name: "Synthetic Organizer",
  join_url: "https://example.test/lobby",
  join_instructions: "Seed joining note",
  location: "Voice",
  timezone: "UTC",
  capacity: 8,
  status: "draft",
  starts_at: "2098-12-31T20:00:00Z",
  ends_at: "2098-12-31T22:00:00Z",
};
const readNames = [...Object.keys(seed)];
const multiline: Record<string, string> = {
  description: "Doors open at 19:30.\nBring a deck.\n\nSnacks provided.",
  accessibility_notes: "Step-free entrance.\nQuiet room upstairs.",
  join_instructions: "1. Open the link.\n2. Ask for the table.\n3. Say hello.",
};
// A single LF becomes two characters on the native form's wire encoding.
const cases = [
  { id: "multiline", typed: multiline },
  {
    id: "wire-at-limit",
    typed: { ...multiline, description: `First\nSecond\n${"x".repeat(985)}` },
  },
  {
    id: "wire-plus-one",
    typed: { ...multiline, description: `First\nSecond\n${"x".repeat(986)}` },
  },
  {
    id: "canonical-at-limit",
    typed: { ...multiline, description: `First line\n${"x".repeat(989)}` },
  },
  {
    id: "canonical-plus-one",
    typed: { ...multiline, description: `First line\n${"x".repeat(990)}` },
  },
];

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const count = (value: string, needle: string) => value.split(needle).length - 1;
function describeText(value: string | null | undefined) {
  if (typeof value !== "string") return value ?? null;
  const rest = value.replaceAll("\r\n", "");
  return {
    value,
    codePoints: [...value].length,
    crlfBreaks: count(value, "\r\n"),
    bareLf: count(rest, "\n"),
    bareCr: count(rest, "\r"),
    sha256: sha256(value),
  };
}

const sql = postgres(requireTestDatabase(process.env.DATABASE_URL), { max: 1 });
const manifest: Record<string, unknown>[] = [];

test.describe.configure({ mode: "serial" });
test.afterAll(async () => {
  try {
    const keys = cases.flatMap((_, i) => viewports.map((_, j) => keyFor(i, j)));
    await sql`delete from events where event_key in ${sql(keys)}`;
  } finally {
    await sql.end();
  }
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, "manifest.json"),
    `${JSON.stringify(
      {
        schema: "event-form-capture-e2e/1",
        phase,
        requestedSha,
        observedHead,
        headMatchesRequested: observedHead === requestedSha,
        route: "GET and native form POST /admin/events/:key on local Wrangler Hono",
        runtime: "local Wrangler Hono with disposable CI Postgres",
        synthetic: true,
        slice: "multiline-and-boundaries",
        viewports,
        cases: manifest,
      },
      null,
      2,
    )}\n`,
  );
});

for (const [caseIndex, scenario] of cases.entries()) {
  for (const [viewportIndex, viewport] of viewports.entries()) {
    test(`event edit form ${scenario.id} native save: ${viewport.name}`, async ({
      page,
      context,
    }) => {
      const typed = scenario.typed;
      const key = keyFor(caseIndex, viewportIndex);
      const route = `/admin/events/${key}`;
      const prefix = `${viewport.name}-${scenario.id}`;
      await mkdir(directory, { recursive: true });

      // Every declared fixture column is required for comparable evidence.
      const columns = new Set(
        (
          await sql`select column_name from information_schema.columns
          where table_schema = current_schema() and table_name = 'events'`
        ).map((row) => row.column_name as string),
      );
      for (const name of readNames)
        expect(columns.has(name), `missing seed column ${name}`).toBe(true);
      const seedValues = seed;
      const readColumns = readNames;
      const readRow = async () => {
        const [row] = await sql`select ${sql(readColumns)} from events where event_key = ${key}`;
        if (!row) return null;
        return Object.fromEntries(
          readColumns.map((n) => [n, row[n] instanceof Date ? row[n].toISOString() : row[n]]),
        );
      };

      // Deterministic reset of only this capture's owned draft.
      await sql`delete from events where event_key = ${key}`;
      await sql`insert into events ${sql({ event_key: key, ...seedValues })}`;
      const seeded = await readRow();
      expect(seeded).not.toBeNull();
      for (const [name, value] of Object.entries(seed)) {
        const expected = name.endsWith("_at") ? new Date(value).toISOString() : value;
        expect(seeded?.[name], `seed mismatch: ${name}`).toEqual(expected);
      }

      await qaLogin(context, "qa-moderator");
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      const load = await page.goto(route);
      expect(load?.status(), "edit GET must render").toBe(200);
      expect(new URL(page.url()).pathname).toBe(route);

      // Read the actual controls, not the fixture's intent.
      const controls: Record<string, unknown> = {};
      const actualInputs: Record<string, unknown> = {};
      for (const name of Object.keys(typed)) {
        const control = page.locator(`form[data-event-editor] [name="${name}"]`);
        await expect(control).toHaveCount(1);
        controls[name] = await control.evaluate((node) => ({
          tag: node.tagName.toLowerCase(),
          type: node.getAttribute("type"),
          maxlength: node.getAttribute("maxlength"),
          required: node.hasAttribute("required"),
          rows: node.getAttribute("rows"),
        }));
        await control.fill(typed[name]!);
        const value = await control.inputValue();
        expect(value, `control value: ${name}`).toBe(typed[name]);
        actualInputs[name] = describeText(value);
      }
      expect(Object.keys(controls), "description control must exist").toContain("description");

      const screenshots = { filled: `${prefix}-1-filled.png`, after: `${prefix}-2-after.png` };
      await page.screenshot({ path: path.join(directory, screenshots.filled), fullPage: true });

      // Native click. waitForRequest only observes; it never routes or alters.
      const posted = page
        .waitForRequest((request) => request.method() === "POST", { timeout: 5000 })
        .catch(() => null);
      await page.locator('form[data-event-editor] [data-testid="save-event"]').click();
      const request = await posted;

      let post: Record<string, unknown> = { sent: false };
      if (request) {
        expect(request.isNavigationRequest(), "POST must be a native form navigation").toBe(true);
        expect(request.resourceType()).toBe("document");
        expect(new URL(request.url()).pathname).toBe(route);
        const response = await request.response();
        expect(response, "native POST needs an HTTP response").not.toBeNull();
        // Validation responses are product evidence, not capture failures.
        const submitted = new URLSearchParams(request.postData() ?? "");
        for (const [name, value] of Object.entries(typed)) {
          expect(submitted.get(name), `submitted value: ${name}`).toBe(
            value.replaceAll("\n", "\r\n"),
          );
        }
        await page.waitForLoadState("load");
        post = {
          sent: true,
          status: response?.status() ?? null,
          location: response?.headers().location ?? null,
          contentType: request.headers()["content-type"] ?? null,
          // Submitted text fields only; the hidden save baseline token is not recorded.
          submitted: Object.fromEntries(
            Object.keys(typed)
              .filter((n) => submitted.has(n))
              .map((n) => [n, describeText(submitted.get(n))]),
          ),
        };
      }
      await page.screenshot({ path: path.join(directory, screenshots.after), fullPage: true });

      // No POST means the browser refused natively: report the actual invalid controls.
      const clientBlockedSubmit = request
        ? null
        : await page.evaluate((names) => {
            const invalid: Record<string, string> = {};
            for (const name of names) {
              const el = document.querySelector<HTMLInputElement>(
                `form[data-event-editor] [name="${name}"]`,
              );
              if (el && !el.checkValidity()) invalid[name] = el.validationMessage;
            }
            return invalid;
          }, Object.keys(typed));
      if (!request) {
        expect(
          Object.keys(clientBlockedSubmit ?? {}).length,
          "missing POST needs native validation",
        ).toBeGreaterThan(0);
      }
      const visibleNotices = await page
        .locator('[role="alert"], [data-testid="form-errors"], .error, .notice')
        .evaluateAll((nodes) => nodes.map((n) => n.textContent?.trim() ?? "").filter(Boolean));

      const stored = await readRow();
      manifest.push({
        case: scenario.id,
        viewport,
        eventKey: key,
        route,
        seeded,
        controls,
        typed: Object.fromEntries(Object.entries(typed).map(([n, v]) => [n, describeText(v)])),
        actualInputs,
        post,
        clientBlockedSubmit,
        finalUrl: new URL(page.url()).pathname + new URL(page.url()).search,
        visibleNotices,
        stored: stored
          ? Object.fromEntries(
              Object.entries(stored).map(([n, v]) => [
                n,
                n in typed ? describeText(v as string) : v,
              ]),
            )
          : null,
        screenshots,
      });
    });
  }
}
