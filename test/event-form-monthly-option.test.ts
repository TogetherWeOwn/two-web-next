// Monthly recurrence: the Hono new-event form keeps the Monthly repeat option.
//
// Regression pin for the rendered Hono creation surface: the Repeat select
// offers the complete option set in order, and a submitted "monthly" value
// redisplays as the selected option. Removing or renaming the Monthly option
// must turn this file red.
import { describe, expect, it } from "vitest";
import { EventFormPage } from "../src/admin/pages";

const renderNew = (values: Record<string, unknown>): string =>
  String(EventFormPage({ mode: "new", values, errors: {} }));

type RecurrenceOption = { value: string; selected: boolean };

function recurrenceOptions(html: string): RecurrenceOption[] {
  const select = html.match(/<select[^>]*name="recurrence_frequency"[^>]*>([\s\S]*?)<\/select>/);
  expect(select, "new-event render keeps the recurrence select").not.toBeNull();
  const options: RecurrenceOption[] = [];
  for (const match of select![1]!.matchAll(/<option\b([^>]*)>/g)) {
    const attrs = match[1]!;
    const value = attrs.match(/\bvalue="([^"]*)"/);
    expect(value, "every recurrence option carries a value").not.toBeNull();
    options.push({
      value: value![1]!,
      selected: /(?:^|\s)selected(?:\s|=|$)/.test(attrs),
    });
  }
  return options;
}

describe("new-event Hono form Monthly option", () => {
  it("offers monthly after weekly, with one-off selected by default", () => {
    const options = recurrenceOptions(renderNew({}));
    expect(options.map((o) => o.value)).toEqual(["", "weekly", "monthly"]);
    expect(options.map((o) => o.selected)).toEqual([true, false, false]);
  });

  it("redisplays a submitted monthly value as the selected option", () => {
    const options = recurrenceOptions(renderNew({ recurrence_frequency: "monthly" }));
    expect(options.map((o) => o.value)).toEqual(["", "weekly", "monthly"]);
    expect(options.map((o) => o.selected)).toEqual([false, false, true]);
    expect(options.filter((o) => o.selected)).toHaveLength(1);
  });
});
