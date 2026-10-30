// Parse the real SSR document, then run its two shipped editor islands in emitted order.
// This narrow DOM adapter needs no browser install and never supplies a draft marker itself.
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { defaultTreeAdapter, parse, type DefaultTreeAdapterMap } from "parse5";

type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];
type Departure = { defaultPrevented: boolean; returnValue?: string; preventDefault: () => void };
type Handler = (event: Departure) => void;

function elements(node: Node): Element[] {
  const children = "childNodes" in node ? node.childNodes.flatMap(elements) : [];
  return "tagName" in node ? [node, ...children] : children;
}

function text(node: Node): string {
  if (node.nodeName === "#text") return (node as DefaultTreeAdapterMap["textNode"]).value;
  return "childNodes" in node ? node.childNodes.map(text).join("") : "";
}

export function featuredEditorDocument(
  html: string,
  {
    navigation = "navigate",
    state = null,
    path = "/admin/featured/41?from=featured-list#edit",
    restoredValues = {},
  }: {
    navigation?: "navigate" | "back_forward" | "reload";
    state?: Record<string, unknown> | null;
    path?: string;
    restoredValues?: Record<string, string>;
  } = {},
) {
  const document = parse(html);
  const values = new WeakMap<Element, string>();
  const handlers = new WeakMap<Element, Map<string, Handler[]>>();
  const windowHandlers = new Map<string, Handler[]>();
  const location = new URL(path, "https://community.example.test");
  const timers = new Map<number, () => void>();
  let nextTimer = 0;

  const getAttribute = (node: Element, name: string) =>
    node.attrs.find((attr) => attr.name === name)?.value ?? null;
  const matches = (node: Element, selector: string) => {
    const match = /^(\w+)?(?:\[([\w-]+)(?:="([^"]*)")?\])?$/.exec(selector);
    if (!match) throw new Error(`Unsupported editor selector: ${selector}`);
    return (
      (!match[1] || node.tagName === match[1]) &&
      (!match[2] ||
        (getAttribute(node, match[2]) !== null &&
          (match[3] === undefined || getAttribute(node, match[2]) === match[3])))
    );
  };
  const find = (root: Node, selector: string) =>
    elements(root).find((node) => matches(node, selector));
  const wrappers = new WeakMap<Element, DomElement>();
  class DomElement {
    constructor(readonly node: Element) {}
    getAttribute(name: string) {
      return getAttribute(this.node, name);
    }
    hasAttribute(name: string) {
      return this.getAttribute(name) !== null;
    }
    setAttribute(name: string, value: string) {
      const attr = this.node.attrs.find((candidate) => candidate.name === name);
      if (attr) attr.value = value;
      else this.node.attrs.push({ name, value });
    }
    removeAttribute(name: string) {
      this.node.attrs = this.node.attrs.filter((attr) => attr.name !== name);
    }
    get value() {
      return (
        values.get(this.node) ??
        (this.node.tagName === "textarea" ? text(this.node) : (this.getAttribute("value") ?? ""))
      );
    }
    set value(value: string) {
      values.set(this.node, value);
    }
    get textContent() {
      return text(this.node);
    }
    set textContent(value: string) {
      this.node.childNodes = [];
      defaultTreeAdapter.insertText(this.node, value);
    }
    set className(value: string) {
      this.setAttribute("class", value);
    }
    set href(value: string) {
      this.setAttribute("href", value);
    }
    get parentNode(): DomElement | null {
      const parent = this.node.parentNode;
      return parent && "tagName" in parent ? wrap(parent) : null;
    }
    appendChild(child: DomElement) {
      defaultTreeAdapter.appendChild(this.node, child.node);
    }
    insertBefore(child: DomElement, reference: DomElement) {
      defaultTreeAdapter.insertBefore(this.node, child.node, reference.node);
    }
    querySelector(selector: string) {
      const node = find(this.node, selector);
      return node ? wrap(node) : null;
    }
    addEventListener(kind: string, handler: Handler) {
      const listeners = handlers.get(this.node) ?? new Map<string, Handler[]>();
      listeners.set(kind, [...(listeners.get(kind) ?? []), handler]);
      handlers.set(this.node, listeners);
    }
    focus() {
      this.setAttribute("data-test-focused", "");
    }
    remove() {
      defaultTreeAdapter.detachNode(this.node);
    }
  }
  function wrap(node: Element): DomElement {
    let wrapper = wrappers.get(node);
    if (!wrapper) {
      wrapper = new DomElement(node);
      wrappers.set(node, wrapper);
    }
    return wrapper;
  }
  const querySelector = (selector: string) => {
    const node = find(document, selector);
    return node ? wrap(node) : null;
  };
  const editor = querySelector("[data-event-editor]");
  if (!editor) throw new Error("The rendered document has no editor form");
  for (const [name, value] of Object.entries(restoredValues)) {
    const field = editor.querySelector(`[name="${name}"]`);
    if (!field) throw new Error(`The rendered editor has no ${name} control`);
    field.value = value;
  }
  function* successfulControls() {
    for (const node of elements(editor!.node)) {
      if (!["input", "textarea"].includes(node.tagName)) continue;
      const field = wrap(node);
      const name = field.getAttribute("name");
      const type = field.getAttribute("type");
      if (!name || field.hasAttribute("disabled")) continue;
      if (type === "checkbox" && !field.hasAttribute("checked")) continue;
      if (["submit", "button", "reset"].includes(type ?? "")) continue;
      yield [name, type === "checkbox" ? (field.getAttribute("value") ?? "on") : field.value];
    }
  }
  const history = {
    state,
    replaceState(next: Record<string, unknown>) {
      this.state = next;
    },
  };
  const setTimeout = (callback: () => void) => {
    const id = ++nextTimer;
    timers.set(id, callback);
    return id;
  };
  const clearTimeout = (id: number) => timers.delete(id);
  const context = createContext({
    document: {
      querySelector,
      createElement: (tag: string) =>
        wrap(defaultTreeAdapter.createElement(tag, editor.node.namespaceURI, [])),
    },
    window: {
      history,
      location,
      performance: { getEntriesByType: () => [{ type: navigation }] },
      addEventListener: (kind: string, handler: Handler) =>
        windowHandlers.set(kind, [...(windowHandlers.get(kind) ?? []), handler]),
      setTimeout,
      clearTimeout,
    },
    FormData: class {
      constructor(form: DomElement) {
        if (form !== editor) throw new Error("The island serialized a different form");
      }
      [Symbol.iterator]() {
        return successfulControls();
      }
    },
    URL,
    URLSearchParams,
    setTimeout,
    clearTimeout,
  });
  const editorScripts = elements(document)
    .filter((node) => node.tagName === "script")
    .map(wrap)
    .filter((node) =>
      ["/islands/featured-edit-history.js", "/islands/admin-event-editor.js"].includes(
        node.getAttribute("src") ?? "",
      ),
    );
  for (const script of editorScripts) {
    const filename = `public${script.getAttribute("src")}`;
    runInContext(readFileSync(filename, "utf8"), context, { filename });
  }
  const dispatch = (listeners: Handler[] = []) => {
    const event: Departure = {
      defaultPrevented: false,
      returnValue: undefined,
      preventDefault() {
        this.defaultPrevented = true;
      },
    };
    for (const listener of listeners) listener(event);
    return event;
  };
  return {
    editor,
    editorScripts,
    history,
    querySelector,
    values: () => Object.fromEntries(successfulControls()),
    depart: () => dispatch(windowHandlers.get("beforeunload")),
    submit: () => dispatch(handlers.get(editor.node)?.get("submit")),
  };
}
