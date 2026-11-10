import { describe, expect, it } from "vitest";
import { submittedFields } from "./helpers/kit-edit-controls";

describe("event edit input/textarea fixture subset", () => {
  it.each(["\n", "\r", "\r\n"])("models native textarea wire breaks for %j", (newline) => {
    const html = `<form><textarea name="description">a${newline}b${newline}${newline}c</textarea></form>`;
    expect(submittedFields(html)).toEqual({ description: "a\r\nb\r\n\r\nc" });
  });

  it("sanitizes text input breaks rather than claiming to preserve them", () => {
    expect(
      submittedFields('<form><input name="organizer_name" value="Jordan&#13;&#10;Smith"></form>'),
    ).toEqual({ organizer_name: "JordanSmith" });
  });

  it("omits disabled, unchecked and submitter-only controls, retaining explicit blank", () => {
    expect(
      submittedFields(`<form>
      <textarea name="clear"></textarea><input name="disabled" disabled value="no">
      <input type="checkbox" name="unchecked"><input type="checkbox" name="checked" checked>
      <input type="submit" name="submit" value="save"><input type="file" name="upload">
      <fieldset disabled><legend><input name="legend" value="yes"></legend>
        <textarea name="hidden">no</textarea></fieldset>
      </form>`),
    ).toEqual({ clear: "", checked: "on", legend: "yes" });
  });

  it("limits extraction to the first form and does not invent omitted controls", () => {
    expect(
      submittedFields(
        '<form><input name="title" value="First"></form><form><input name="other" value="Second"></form>',
      ),
    ).toEqual({ title: "First" });
  });
});
