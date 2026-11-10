import { parse, type DefaultTreeAdapterMap } from "parse5";

type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];

export function attr(el: Element, name: string): string | undefined {
  return el.attrs.find((a) => a.name === name)?.value;
}

export function elements(node: Node, out: Element[] = []): Element[] {
  if ("tagName" in node) out.push(node);
  const kids = "childNodes" in node ? node.childNodes : [];
  for (const kid of kids) elements(kid, out);
  return out;
}

export function textOf(node: Node): string {
  if ("value" in node && node.nodeName === "#text") return node.value;
  return ("childNodes" in node ? node.childNodes : []).map(textOf).join("");
}

export function firstForm(html: string): Element {
  const form = elements(parse(html)).find((el) => el.tagName === "form");
  if (!form) throw new Error("no form rendered");
  return form;
}

function controls(form: Element): Element[] {
  return elements(form).filter((el) => el.tagName === "input" || el.tagName === "textarea");
}

export function disabled(el: Element): boolean {
  if (attr(el, "disabled") !== undefined) return true;
  let ancestor = el.parentNode;
  while (ancestor) {
    if ("tagName" in ancestor && ancestor.tagName === "fieldset") {
      const legend = ancestor.childNodes.find(
        (node): node is Element => "tagName" in node && node.tagName === "legend",
      );
      if (attr(ancestor, "disabled") !== undefined && (!legend || !elements(legend).includes(el))) {
        return true;
      }
    }
    ancestor = "parentNode" in ancestor ? ancestor.parentNode : null;
  }
  return false;
}

/**
 * First-form input/textarea fixture subset, without a submitter. Textarea values
 * use native urlencoded CRLF (not DOM FormData's LF); text inputs drop breaks.
 * Not a browser: no selects, external form owners, duplicate-name lists, live
 * edits, constraint validation, or complete input-type sanitization/encoding.
 * Use actual browser requests for wire-fidelity claims.
 */
export function submittedFields(html: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const el of controls(firstForm(html))) {
    const name = attr(el, "name");
    if (!name || disabled(el)) continue;
    const type = (attr(el, "type") ?? "text").toLowerCase();
    if (el.tagName === "input") {
      if (["button", "submit", "reset", "image", "file"].includes(type)) continue;
      if (["checkbox", "radio"].includes(type) && attr(el, "checked") === undefined) continue;
    }
    let value =
      el.tagName === "textarea"
        ? textOf(el).replace(/\r\n?/g, "\n").replace(/\n/g, "\r\n")
        : (attr(el, "value") ?? (["checkbox", "radio"].includes(type) ? "on" : ""));
    if (
      el.tagName === "input" &&
      ["text", "search", "tel", "password", "url", "email"].includes(type)
    ) {
      value = value.replace(/[\r\n]/g, "");
      if (type === "url" || type === "email")
        value = value.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, "");
    }
    out[name] = value;
  }
  return out;
}

export function controlNamed(html: string, name: string): Element | undefined {
  return controls(firstForm(html)).find((el) => attr(el, "name") === name);
}
