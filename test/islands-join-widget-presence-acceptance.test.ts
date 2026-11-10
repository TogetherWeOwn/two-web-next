import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { URL as NodeURL } from "node:url";
import { describe, expect, it, type Mock, vi } from "vitest";

// Acceptance suite: loading the live Discord preview must never erase the
// presence snapshot.
//
// Contract under test (both /join twins — src/screens/join.tsx and
// web/src/routes/join/+page.svelte render the same `.join-preview` region:
// the presence <section data-testid="join-widget-presence"> and, beside it,
// the strap holding the [data-join-widget] load link; both serve the same
// /islands/join-widget.js island):
//  1. While the live preview is loading and after it loads, the presence
//     snapshot stays in the DOM: same section node, online count, channel
//     list and widget invite link intact and not hidden.
//  2. A failed load (signaled `error`, or the bounded timer with no load)
//     keeps the snapshot, drops the dead frame, shows the invite guidance
//     and restores the load control so the visitor can retry.
//  3. A blocked load (error page that still fires `load`, then the timer)
//     keeps the snapshot and the frame, with guidance beside them — the
//     blocked-load suite's beside-frame contract is unchanged.
//  4. Repeat clicks never stack frames: at most one preview frame is ever
//     created for one successful load, before or after `load`.
//  5. Modified / non-primary clicks stay native (no preventDefault, no
//     frame) and leave the snapshot untouched.
//  6. Focus is never stolen or stranded: a load does not move focus the
//     visitor has moved elsewhere; on failure, focus that was on the load
//     control lands on a connected element inside the preview region (the
//     restored control or the guidance), never on a removed node or loose
//     on <body>; focus the visitor moved elsewhere is left alone.
//  7. The no-snapshot variant (strap only) keeps its legacy behavior:
//     click frames the widget, failure guides to the invite.
//  8. The island never calls replaceChildren on the snapshot container
//     (.join-preview or the presence section) — pinned at runtime by
//     instrumenting every fixture node's replaceChildren, and statically
//     by scanning the island source for a replaceChildren call on any
//     binding resolved from the .join-preview / presence hooks.
//
// Hermetic: no DB, no network. The shipped island text
// (public/islands/join-widget.js — what both twins serve) runs in a vm
// against a fixture DOM mirroring the SSR markup both twins emit today.
// The harness is deliberately shape-tolerant (real ancestor/sibling walks,
// listeners or onload/onerror, guidance found by testid or live-region
// text): it pins DOM end states, not the Builder's mechanism. Run with:
//   npx vitest run test/islands-join-widget-presence-acceptance.test.ts

const binder = readFileSync(
  new NodeURL("../public/islands/join-widget.js", import.meta.url),
  "utf8",
);
const islandSource = readFileSync(
  new NodeURL("../assets/islands/join-widget.js", import.meta.url),
  "utf8",
);
const WIDGET = "https://discord.com/widget?id=326474832151838730&theme=dark";
const INVITE = "https://discord.gg/invite";
const WIDGET_INVITE = "https://discord.gg/widget-invite";

type El = {
  tagName: string;
  children: El[];
  parent: El | null;
  attrs: Record<string, string>;
  dataset: Record<string, string>;
  listeners: Record<string, Array<(e: unknown) => void>>;
  textContent: string;
  innerHTML: string;
  className: string;
  style: Record<string, string>;
  hidden: boolean;
  src?: string;
  href?: string;
  title?: string;
  width?: string;
  height?: string;
  onload?: ((e: unknown) => void) | null;
  onerror?: ((e: unknown) => void) | null;
  onclick?: ((e: unknown) => void) | null;
  removed: boolean;
  focus: Mock<() => void>;
  blur: Mock<() => void>;
  classList: {
    add: (...c: string[]) => void;
    remove: (...c: string[]) => void;
    contains: (c: string) => boolean;
    toggle: (c: string, force?: boolean) => boolean;
  };
  setAttribute: (k: string, v: string) => void;
  getAttribute: (k: string) => string | null;
  hasAttribute: (k: string) => boolean;
  removeAttribute: (k: string) => void;
  addEventListener: (k: string, fn: (e: unknown) => void) => void;
  removeEventListener: (k: string, fn: (e: unknown) => void) => void;
  appendChild: (n: El) => El;
  append: (...n: El[]) => void;
  prepend: (...n: El[]) => void;
  replaceChildren: (...n: El[]) => void;
  replaceWith: (...n: El[]) => void;
  insertBefore: (n: El, ref: El | null) => El;
  insertAdjacentElement: (pos: string, n: El) => El | null;
  after: (...n: El[]) => void;
  before: (...n: El[]) => void;
  remove: () => void;
  contains: (n: El | null) => boolean;
  matches: (sel: string) => boolean;
  closest: (sel: string) => El | null;
  querySelector: (sel: string) => El | null;
  querySelectorAll: (sel: string) => El[];
  fire: (kind: string, event?: Record<string, unknown>) => void;
};

function page(opts: { snapshot?: boolean } = {}) {
  const withSnapshot = opts.snapshot !== false;
  const created: El[] = [];
  let activeElement: El | null = null;
  const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  const replaceChildrenCalls: Array<{ el: El; nodes: El[] }> = [];

  function matchesOne(el: El, sel: string): boolean {
    // Minimal selector support: tag, .class, [attr], [attr="v"] compounds.
    let rest = sel.trim();
    if (!rest) return false;
    const tag = rest.match(/^[a-zA-Z][\w-]*/);
    if (tag) {
      if (el.tagName !== tag[0].toUpperCase()) return false;
      rest = rest.slice(tag[0].length);
    }
    while (rest.length > 0) {
      if (rest.startsWith(".")) {
        const m = rest.match(/^\.([\w-]+)/);
        if (!m || !el.className.split(/\s+/).includes(m[1] ?? "")) return false;
        rest = rest.slice(m[0].length);
      } else if (rest.startsWith("[")) {
        const m = rest.match(/^\[([\w-]+)(?:=["']?([^"'\]]*)["']?)?\]/);
        if (!m) return false;
        const value = el.getAttribute(m[1] ?? "");
        if (value === null) return false;
        if (m[2] !== undefined && value !== m[2]) return false;
        rest = rest.slice(m[0].length);
      } else {
        return false;
      }
    }
    return true;
  }

  function deepNodes(el: El): El[] {
    return [el, ...el.children.flatMap(deepNodes)];
  }
  function deepText(el: El): string {
    return [el.textContent, ...el.children.map(deepText)].join(" ");
  }

  function makeEl(tag: string): El {
    let ownText = "";
    const el: El = {
      tagName: tag.toUpperCase(),
      children: [],
      parent: null,
      attrs: {},
      dataset: {},
      listeners: {},
      textContent: "",
      innerHTML: "",
      className: "",
      style: {},
      hidden: false,
      removed: false,
      focus: vi.fn(() => {
        activeElement = el;
      }),
      blur: vi.fn(() => {
        if (activeElement === el) activeElement = body;
      }),
      classList: {
        add(...c: string[]) {
          const set = new Set([...el.className.split(/\s+/).filter(Boolean), ...c]);
          el.className = [...set].join(" ");
          el.attrs.class = el.className;
        },
        remove(...c: string[]) {
          el.className = el.className
            .split(/\s+/)
            .filter((x) => x && !c.includes(x))
            .join(" ");
          el.attrs.class = el.className;
        },
        contains(c: string) {
          return el.className.split(/\s+/).includes(c);
        },
        toggle(c: string, force?: boolean) {
          const on = force ?? !el.classList.contains(c);
          if (on) el.classList.add(c);
          else el.classList.remove(c);
          return on;
        },
      },
      setAttribute(k, v) {
        el.attrs[k] = String(v);
        if (k === "src") el.src = String(v);
        if (k === "href") el.href = String(v);
        if (k === "class") el.className = String(v);
        if (k === "hidden") el.hidden = true;
        if (k.startsWith("data-")) {
          const key = k.slice(5).replace(/-(\w)/g, (_, c: string) => c.toUpperCase());
          el.dataset[key] = String(v);
        }
      },
      getAttribute(k) {
        if (k === "href" && el.href) return el.href;
        if (k === "src" && el.src) return el.src;
        return k in el.attrs ? (el.attrs[k] ?? null) : null;
      },
      hasAttribute(k) {
        return el.getAttribute(k) !== null;
      },
      removeAttribute(k) {
        delete el.attrs[k];
        if (k === "hidden") el.hidden = false;
      },
      addEventListener(k, fn) {
        (el.listeners[k] ??= []).push(fn);
      },
      removeEventListener(k, fn) {
        el.listeners[k] = (el.listeners[k] ?? []).filter((f) => f !== fn);
      },
      appendChild(n) {
        adopt(el, [n]);
        return n;
      },
      append(...n) {
        adopt(el, n);
      },
      prepend(...n) {
        adopt(el, n, 0);
      },
      replaceChildren(...n) {
        replaceChildrenCalls.push({ el, nodes: [...n] });
        for (const child of [...el.children]) detach(child);
        el.children = [];
        adopt(el, n);
      },
      replaceWith(...n) {
        const parent = el.parent;
        if (!parent) return;
        const at = parent.children.indexOf(el);
        detach(el);
        adopt(parent, n, at === -1 ? undefined : at);
      },
      insertBefore(n, ref) {
        const at = ref ? el.children.indexOf(ref) : -1;
        adopt(el, [n], at === -1 ? undefined : at);
        return n;
      },
      insertAdjacentElement(pos, n) {
        if (pos === "beforebegin" && el.parent)
          adopt(el.parent, [n], el.parent.children.indexOf(el));
        else if (pos === "afterbegin") adopt(el, [n], 0);
        else if (pos === "beforeend") adopt(el, [n]);
        else if (pos === "afterend" && el.parent)
          adopt(el.parent, [n], el.parent.children.indexOf(el) + 1);
        else return null;
        return n;
      },
      after(...n) {
        if (el.parent) adopt(el.parent, n, el.parent.children.indexOf(el) + 1);
      },
      before(...n) {
        if (el.parent) adopt(el.parent, n, el.parent.children.indexOf(el));
      },
      remove() {
        detach(el);
      },
      contains(n) {
        return !!n && (n === el || el.children.some((c) => c.contains(n)));
      },
      matches(sel) {
        return sel.split(",").some((part) => matchesOne(el, part));
      },
      closest(sel) {
        let node: El | null = el;
        while (node) {
          if (node.matches(sel)) return node;
          node = node.parent;
        }
        return null;
      },
      querySelector(sel) {
        return deepNodes(el).find((n) => n !== el && n.matches(sel)) ?? null;
      },
      querySelectorAll(sel) {
        return deepNodes(el).filter((n) => n !== el && n.matches(sel));
      },
      fire(kind, event = {}) {
        for (const fn of [...(el.listeners[kind] ?? [])]) fn({ type: kind, ...event });
        const prop =
          kind === "load"
            ? el.onload
            : kind === "error"
              ? el.onerror
              : kind === "click"
                ? el.onclick
                : null;
        if (typeof prop === "function") prop({ type: kind, ...event });
      },
    };
    // Real textContent semantics: reading is deep, writing replaces all
    // children. ownText holds this node's own text for deepText() walks via
    // the getter's first segment.
    Object.defineProperty(el, "textContent", {
      get() {
        return ownText;
      },
      set(value: string) {
        for (const child of [...el.children]) detach(child);
        el.children = [];
        ownText = String(value ?? "");
        syncFocus();
      },
    });
    Object.defineProperty(el, "innerHTML", {
      get() {
        return ownText;
      },
      set(value: string) {
        for (const child of [...el.children]) detach(child);
        el.children = [];
        ownText = String(value ?? "");
        syncFocus();
      },
    });
    return el;
  }

  function detach(node: El) {
    node.removed = true;
    if (node.parent) node.parent.children = node.parent.children.filter((c) => c !== node);
    node.parent = null;
    syncFocus();
  }

  function adopt(parent: El, nodes: El[], at?: number) {
    for (const n of nodes) {
      if (n.parent) n.parent.children = n.parent.children.filter((c) => c !== n);
      n.parent = parent;
      n.removed = false;
    }
    if (at === undefined) parent.children.push(...nodes);
    else parent.children.splice(at, 0, ...nodes);
    syncFocus();
  }

  // A real browser drops focus to <body> when the focused node leaves the
  // document; the island's steal guard reads exactly that state.
  function syncFocus() {
    if (!activeElement || activeElement === body) return;
    let node: El | null = activeElement;
    while (node && node !== body) node = node.parent;
    if (node !== body) activeElement = body;
  }

  const body = makeEl("body");

  // Page-level join panel invite (data-testid="join-invite"), outside the
  // preview region — the island's guidance links here.
  const panel = makeEl("div");
  panel.className = "join-panel";
  const panelInvite = makeEl("a");
  panelInvite.setAttribute("data-testid", "join-invite");
  panelInvite.href = INVITE;
  panelInvite.textContent = "Join with an invite link instead";
  panel.appendChild(panelInvite);

  // The preview region both twins render.
  const preview = makeEl("div");
  preview.className = "join-preview";

  let presence: El | null = null;
  let online: El | null = null;
  let channels: El | null = null;
  let widgetInvite: El | null = null;
  if (withSnapshot) {
    presence = makeEl("section");
    presence.setAttribute("data-testid", "join-widget-presence");
    presence.setAttribute("aria-labelledby", "discord-presence-heading");
    const heading = makeEl("h2");
    heading.textContent = "In Together We Own now";
    online = makeEl("p");
    online.setAttribute("data-testid", "join-widget-online");
    const count = makeEl("strong");
    count.textContent = "42";
    // Write own text first: the textContent setter clears children.
    online.textContent = " members online";
    online.appendChild(count);
    const inviteWrap = makeEl("p");
    widgetInvite = makeEl("a");
    widgetInvite.setAttribute("data-testid", "join-widget-invite");
    widgetInvite.href = WIDGET_INVITE;
    widgetInvite.textContent = "Join with an invite link";
    inviteWrap.appendChild(widgetInvite);
    const channelsHeading = makeEl("h3");
    channelsHeading.textContent = "Voice and stage channels";
    channels = makeEl("ul");
    channels.setAttribute("data-testid", "join-widget-channels");
    for (const name of ["stage-night", "lobby-voice"]) {
      const li = makeEl("li");
      li.textContent = name;
      channels.appendChild(li);
    }
    presence.append(heading, online, inviteWrap, channelsHeading, channels);
    preview.appendChild(presence);
  }

  const strap = makeEl("div");
  strap.className = "strap";
  const strapCopy = makeEl("p");
  strapCopy.textContent = "Discord's live server preview loads only when you ask for it.";
  const link = makeEl("a");
  link.className = "btn";
  link.href = WIDGET;
  link.setAttribute("data-join-widget", "");
  link.setAttribute("data-testid", "join-widget-load");
  link.setAttribute("referrerpolicy", "no-referrer");
  link.textContent = "Show live server preview";
  strap.append(strapCopy, link);
  preview.appendChild(strap);

  body.append(panel, preview);
  activeElement = body;

  const document: {
    body: El;
    activeElement: El | null;
    querySelector: (sel: string) => El | null;
    querySelectorAll: (sel: string) => El[];
    createElement: (tag: string) => El;
    createTextNode: (text: string) => El;
  } = {
    body,
    get activeElement() {
      return activeElement;
    },
    set activeElement(value: El | null) {
      activeElement = value;
    },
    querySelector(sel: string) {
      return deepNodes(body).find((n) => n !== body && n.matches(sel)) ?? null;
    },
    querySelectorAll(sel: string) {
      return deepNodes(body).filter((n) => n !== body && n.matches(sel));
    },
    createElement(tag: string) {
      const el = makeEl(tag);
      created.push(el);
      return el;
    },
    createTextNode(text: string) {
      const el = makeEl("#text");
      el.textContent = String(text);
      created.push(el);
      return el;
    },
  };

  const sandbox: Record<string, unknown> = {
    document,
    setTimeout(fn: () => void, ms = 0) {
      timers.push({ fn, ms: Number(ms) || 0, cleared: false });
      return timers.length;
    },
    clearTimeout(id: number) {
      const t = timers[id - 1];
      if (t) t.cleared = true;
    },
    console,
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  runInNewContext(binder, sandbox);

  const allEls = () => deepNodes(body).concat(created);
  const framesCreated = () => created.filter((e) => e.tagName === "IFRAME");
  const framesInDom = () => deepNodes(body).filter((e) => e.tagName === "IFRAME");
  const loadControl = (): El | null =>
    deepNodes(body).find(
      (n) =>
        n.getAttribute("data-testid") === "join-widget-load" || n.hasAttribute("data-join-widget"),
    ) ?? null;

  function guidanceShown(): boolean {
    return deepNodes(preview).some((n) => {
      if (n === preview || (presence && presence.contains(n))) return false;
      if (n.getAttribute("data-testid") === "join-widget-error") return true;
      const announced = n.attrs.role === "status" || "aria-live" in n.attrs;
      return announced && /preview|invite/i.test(deepText(n));
    });
  }

  function snapshotIntact(): void {
    expect(presence, "fixture must include the snapshot").not.toBeNull();
    expect(
      preview.contains(presence),
      "the presence section node itself stays inside .join-preview",
    ).toBe(true);
    expect(presence?.removed, "the presence section is never removed").toBe(false);
    expect(presence?.hidden, "the presence section is not hidden").toBe(false);
    expect(
      presence?.attrs.hidden,
      "the presence section gains no hidden attribute",
    ).toBeUndefined();
    expect(presence?.style.display, "the presence section is not display:none").not.toBe("none");
    expect(deepText(online!), "online count stays").toContain("42");
    expect(deepText(online!), "online label stays").toContain("members online");
    expect(deepText(channels!), "channel list stays").toContain("stage-night");
    expect(deepText(channels!), "channel list stays").toContain("lobby-voice");
    expect(
      widgetInvite?.getAttribute("href"),
      "the snapshot's invite link stays with its href",
    ).toBe(WIDGET_INVITE);
    expect(presence?.contains(widgetInvite!), "the snapshot invite stays in the section").toBe(
      true,
    );
  }

  function noSnapshotContainerReplace(): void {
    const violations = replaceChildrenCalls.filter(
      (call) => call.el === preview || (presence !== null && call.el === presence),
    );
    expect(
      violations,
      "the island never calls replaceChildren on the snapshot container (.join-preview / presence section)",
    ).toEqual([]);
  }

  return {
    body,
    document,
    preview,
    presence,
    link,
    panelInvite,
    timers,
    created,
    framesCreated,
    framesInDom,
    loadControl,
    guidanceShown,
    snapshotIntact,
    noSnapshotContainerReplace,
    click(control: El, extra: Record<string, unknown> = {}) {
      // A real click focuses the link first (mousedown), then dispatches.
      control.focus();
      const event: Record<string, unknown> = {
        type: "click",
        button: 0,
        defaultPrevented: false,
        preventDefault: vi.fn(() => {
          event.defaultPrevented = true;
        }),
        ...extra,
      };
      control.fire("click", event);
      return event;
    },
    fireTimers() {
      for (const t of [...timers]) if (!t.cleared) t.fn();
    },
    focusCallsDuring(fn: () => void): number {
      for (const el of allEls()) {
        el.focus.mockClear();
        el.blur.mockClear();
      }
      fn();
      return allEls().reduce(
        (sum, el) => sum + el.focus.mock.calls.length + el.blur.mock.calls.length,
        0,
      );
    },
  };
}

describe("join preview acceptance: the presence snapshot survives the live preview", () => {
  it("successful load keeps the snapshot in the DOM while loading and after load", () => {
    const p = page();
    p.snapshotIntact();
    p.click(p.link);
    // Still loading — no load event yet: snapshot must already still be there.
    p.snapshotIntact();
    expect(p.framesInDom(), "one preview frame is loading").toHaveLength(1);
    p.framesCreated()[0]?.fire("load");
    p.snapshotIntact();
    expect(p.framesInDom()).toHaveLength(1);
    expect(p.preview.contains(p.framesInDom()[0]!), "the frame lives in the preview region").toBe(
      true,
    );
    p.noSnapshotContainerReplace();
  });

  it("a signaled error keeps the snapshot, drops the frame, guides and restores the control", () => {
    const p = page();
    p.click(p.link);
    p.framesCreated()[0]?.fire("error");
    p.snapshotIntact();
    expect(p.framesInDom(), "the dead frame is gone").toHaveLength(0);
    expect(p.guidanceShown(), "invite guidance is shown").toBe(true);
    const restored = p.loadControl();
    expect(restored, "the load control is restored after a failed load").not.toBeNull();
    expect(restored?.getAttribute("href")).toBe(WIDGET);
    p.noSnapshotContainerReplace();
    // The restored control actually retries.
    p.click(restored!);
    p.snapshotIntact();
    expect(p.framesInDom(), "retry loads exactly one new frame").toHaveLength(1);
    p.noSnapshotContainerReplace();
  });

  it("a load that never arrives (bounded timer, no load) keeps the snapshot and restores the control", () => {
    const p = page();
    p.click(p.link);
    p.snapshotIntact();
    p.fireTimers();
    p.snapshotIntact();
    expect(p.framesInDom(), "the never-loaded frame is gone").toHaveLength(0);
    expect(p.guidanceShown(), "invite guidance is shown").toBe(true);
    const restored = p.loadControl();
    expect(restored, "the load control is restored after a timed-out load").not.toBeNull();
    expect(restored?.getAttribute("href")).toBe(WIDGET);
    p.noSnapshotContainerReplace();
  });

  it("a blocked load (load fires, then the timer) keeps snapshot, frame and beside-frame guidance", () => {
    const p = page();
    p.click(p.link);
    const frame = p.framesCreated()[0]!;
    frame.fire("load");
    const focusAfterLoad = p.document.activeElement;
    const calls = p.focusCallsDuring(() => p.fireTimers());
    p.snapshotIntact();
    expect(p.framesInDom(), "a frame that really rendered is kept").toHaveLength(1);
    expect(p.guidanceShown(), "guidance appears beside the frame").toBe(true);
    expect(calls, "post-load timer guidance never moves focus").toBe(0);
    expect(p.document.activeElement).toBe(focusAfterLoad);
    p.noSnapshotContainerReplace();
  });

  it("repeat clicks stack no frames, before or after load", () => {
    const p = page();
    for (let i = 0; i < 3; i++) {
      const control = p.loadControl();
      if (!control) break;
      p.click(control);
      p.snapshotIntact();
    }
    expect(p.framesCreated(), "repeat clicks create at most one frame").toHaveLength(1);
    expect(p.framesInDom()).toHaveLength(1);
    p.framesCreated()[0]?.fire("load");
    const controlAfterLoad = p.loadControl();
    if (controlAfterLoad) {
      p.click(controlAfterLoad);
      expect(
        p.framesCreated(),
        "a click after a successful load stacks no second frame",
      ).toHaveLength(1);
      expect(p.framesInDom()).toHaveLength(1);
    }
    p.snapshotIntact();
    p.noSnapshotContainerReplace();
  });

  it.each([
    { button: 1 },
    { button: 0, ctrlKey: true },
    { button: 0, metaKey: true },
    { button: 0, shiftKey: true },
    { button: 0, altKey: true },
  ])(
    "modified or non-primary clicks stay native and leave the snapshot untouched (%o)",
    (extra) => {
      const p = page();
      const event = p.click(p.link, extra);
      expect(event.preventDefault).not.toHaveBeenCalled();
      expect(p.framesCreated()).toHaveLength(0);
      p.snapshotIntact();
      expect(p.loadControl(), "the native link is still there for the browser").not.toBeNull();
      p.noSnapshotContainerReplace();
    },
  );

  it("focus that was on the load control is not stranded when the load fails", () => {
    const p = page();
    // Keyboard path: focus rests on the control when it is activated.
    p.link.focus();
    expect(p.document.activeElement).toBe(p.link);
    p.click(p.link);
    p.framesCreated()[0]?.fire("error");
    p.snapshotIntact();
    const active = p.document.activeElement;
    expect(active, "focus is somewhere deliberate, not dropped").not.toBeNull();
    expect(active, "focus is not stranded on <body>").not.toBe(p.body);
    expect(
      p.preview.contains(active),
      "focus lands inside the preview region (restored control or guidance), never on a removed node",
    ).toBe(true);
  });

  it("focus the visitor moved elsewhere is never stolen by load or failure", () => {
    const loaded = page();
    loaded.click(loaded.link);
    loaded.panelInvite.focus();
    const loadCalls = loaded.focusCallsDuring(() => loaded.framesCreated()[0]?.fire("load"));
    expect(loadCalls, "a late load does not steal focus").toBe(0);
    expect(loaded.document.activeElement).toBe(loaded.panelInvite);
    loaded.snapshotIntact();

    const failed = page();
    failed.click(failed.link);
    failed.panelInvite.focus();
    const errorCalls = failed.focusCallsDuring(() => failed.framesCreated()[0]?.fire("error"));
    expect(errorCalls, "failure guidance does not steal focus").toBe(0);
    expect(failed.document.activeElement).toBe(failed.panelInvite);
    failed.snapshotIntact();
  });

  it("no-snapshot variant is unchanged: click frames the widget, failure guides", () => {
    const ok = page({ snapshot: false });
    ok.click(ok.link);
    expect(ok.framesInDom()).toHaveLength(1);
    ok.framesCreated()[0]?.fire("load");
    expect(ok.framesInDom()).toHaveLength(1);
    expect(
      ok.body.contains(ok.document.activeElement) || ok.document.activeElement === ok.body,
      "focus rests on a connected element",
    ).toBe(true);

    const bad = page({ snapshot: false });
    bad.click(bad.link);
    bad.framesCreated()[0]?.fire("error");
    expect(bad.framesInDom()).toHaveLength(0);
    expect(bad.guidanceShown()).toBe(true);
  });

  it("never calls replaceChildren on the snapshot container across success and failure flows", () => {
    const ok = page();
    ok.click(ok.link);
    ok.framesCreated()[0]?.fire("load");
    ok.fireTimers();
    ok.noSnapshotContainerReplace();

    const bad = page();
    bad.click(bad.link);
    bad.framesCreated()[0]?.fire("error");
    bad.fireTimers();
    bad.noSnapshotContainerReplace();
  });
});

describe("join preview acceptance: structural pins", () => {
  // For each island text (readable source + shipped minified), every
  // binding resolved from the snapshot-container hooks must never be the
  // receiver of replaceChildren. Restructuring away from those hooks
  // passes here and stays guarded by the runtime instrumentation above.
  const hookPattern = String.raw`(?:\.join-preview|join-widget-presence)`;
  for (const [label, text] of [
    ["assets/islands/join-widget.js", islandSource],
    ["public/islands/join-widget.js (shipped)", binder],
  ] as const) {
    it(`${label}: no replaceChildren on a snapshot-container binding`, () => {
      const bound = new Set<string>();
      // The span between `=` and the hook call may not cross a comma or a
      // second `=`: minified multi-declarations would otherwise bind the
      // first declarator instead of the hook's own variable.
      const assignRe = new RegExp(
        String.raw`([A-Za-z_$][\w$]*)\s*=\s*[^;{},=]*?(?:closest|querySelector)\(\s*["'][^"']*${hookPattern}`,
        "g",
      );
      for (const m of text.matchAll(assignRe)) if (m[1]) bound.add(m[1]);
      if (
        new RegExp(String.raw`(?:closest|querySelector)\(\s*["'][^"']*${hookPattern}`).test(text)
      ) {
        expect(
          bound.size,
          `${label}: the island still resolves the snapshot container from its hook, so the binding scan must not be vacuous`,
        ).toBeGreaterThan(0);
      }
      for (const id of bound) {
        expect(
          new RegExp(String.raw`\b${id}\s*\.\s*replaceChildren\s*\(`).test(text),
          `${label}: binding "${id}" (from the snapshot-container hook) must not receive replaceChildren`,
        ).toBe(false);
      }
      expect(
        new RegExp(
          String.raw`(?:closest|querySelector)\(\s*["'][^"']*${hookPattern}[^"']*["']\s*\)\s*\.\s*replaceChildren\s*\(`,
        ).test(text),
        `${label}: no direct snapshot-container .replaceChildren( chain`,
      ).toBe(false);
    });
  }

  it("both twins still render the snapshot, the load control and the island hook", () => {
    for (const rel of ["../src/screens/join.tsx", "../web/src/routes/join/+page.svelte"]) {
      const markup = readFileSync(new NodeURL(rel, import.meta.url), "utf8");
      for (const needle of [
        "join-preview",
        'data-testid="join-widget-presence"',
        'data-testid="join-widget-online"',
        'data-testid="join-widget-channels"',
        'data-testid="join-widget-invite"',
        'data-testid="join-widget-load"',
        "data-join-widget",
      ]) {
        expect(markup, `${rel} keeps ${needle}`).toContain(needle);
      }
    }
  });
});
