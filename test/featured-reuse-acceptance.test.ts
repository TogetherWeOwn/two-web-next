import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  editorial,
  fixture,
  formValues,
  newForm,
  renderers,
  reuseHref,
  sourceRow,
} from "./helpers/featured-reuse-fixture";

const network = vi.fn(async () => {
  throw new Error("FR-NETWORK reuse must not fetch an arbitrary source URL");
});
beforeEach(() => {
  network.mockClear();
  vi.stubGlobal("fetch", network);
});
afterEach(() => {
  try {
    expect(
      network,
      "FR-NETWORK: use the bounded local record read, never fetch a source URL",
    ).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});

// Missing prefill, copying publication/identity, treating an outage as an empty
// success, or re-reading the source at submit must break this contract. The
// fixture replaces SQL transport only: routes, classified reads, validators,
// templates, create model and audit generation all remain production code.
for (const renderer of renderers) {
  describe(`featured reuse / ${renderer}`, () => {
    it("FR-C01 ordinary new form retains empty defaults without a source read", async () => {
      const f = await fixture();
      const response = await f.get(renderer, "/admin/featured/new");
      expect(response.status).toBe(200);
      const form = newForm(await response.text());
      expect(formValues(form)).toEqual({
        title: "",
        body: "",
        url: "",
        image_url: "",
        image_alt: "",
        position: "0",
        starts_at: "",
        ends_at: "",
      });
      expect(f.reads()).toHaveLength(0);
      expect(f.writes()).toHaveLength(0);
    });

    it("FR-01 saved editor offers one labelled same-origin read-only reuse link", async () => {
      const f = await fixture();
      const response = await f.get(renderer, "/admin/featured/41");
      expect(response.status).toBe(200);
      const href = reuseHref(await response.text());
      expect(
        href,
        "FR-01 missing-link: offer Reuse as new slot in the saved editor",
      ).not.toBeNull();
      const url = new URL(href!, f.origin);
      expect(url.origin).toBe(f.origin);
      expect(url.pathname).toBe("/admin/featured/new");
      const sources = [...url.searchParams].filter(([, value]) => value === "41");
      expect(sources).toHaveLength(1);
      expect(url.searchParams.getAll(sources[0]![0])).toEqual(["41"]);
      expect(url.hash).toBe("");
      expect(f.writes()).toHaveLength(0);
    });

    for (const state of ["live", "expired", "unpublished"] as const) {
      it(`FR-02-${state} prefill copies editorial content only and performs one read, zero writes`, async () => {
        const source = sourceRow(state);
        const before = structuredClone(source);
        const f = await fixture(source);
        const response = await f.get(renderer, await f.reuseUrl(renderer));
        expect(response.status).toBe(200);
        const html = await response.text();
        const form = newForm(html);
        expect(
          formValues(form),
          "FR-02 no-prefill: copy editorial fields, not source scheduling",
        ).toEqual({
          ...editorial,
          position: "0",
          starts_at: "",
          ends_at: "",
        });
        expect(form.querySelector('[name="is_published"]')?.hasAttribute("checked")).toBe(false);
        expect(html).toMatch(/unsaved|not (?:yet )?saved/i);
        expect(
          form.querySelector(
            '[name="id"], [name="created_by"], [name="created_at"], [name="updated_at"], [name="legacy_id"]',
          ),
        ).toBeNull();
        expect(form.querySelector('[data-testid="save-featured"]')?.textContent).toMatch(/Create/);
        expect(form.querySelector('[data-testid="delete-featured"]')).toBeNull();
        expect(html).not.toContain('data-testid="featured-preview"');
        expect(response.headers.get("cache-control")).toContain("no-store");
        expect(f.reads()).toHaveLength(1);
        expect(f.reads()[0]?.params).toContain(41);
        expect(f.writes()).toHaveLength(0);
        expect(f.source()).toEqual(before);
      });
    }

    for (const raw of [
      "",
      "0",
      "-1",
      "01",
      "+41",
      "41.0",
      "4e1",
      " 41",
      "41x",
      "2147483648",
      "9007199254740993",
      "https://example.org/source",
    ]) {
      it(`FR-03-${JSON.stringify(raw)} rejects noncanonical or out-of-range source before lookup`, async () => {
        const f = await fixture();
        const url = new URL(await f.reuseUrl(renderer), f.origin);
        const key = [...url.searchParams].find(([, value]) => value === "41")![0];
        url.searchParams.set(key, raw);
        f.clearCalls();
        const response = await f.get(renderer, url.pathname + url.search);
        expect([200, 302, 303, 404, 422]).toContain(response.status);
        const recovered = await f.followRecovery(renderer, response);
        expect(formValues(newForm(recovered.html)).title).toBe("");
        expect(
          recovered.honest,
          "FR-03 silent-recovery: explain failed reuse or redirect to the ordinary empty form",
        ).toBe(true);
        expect(f.reads()).toHaveLength(0);
        expect(f.writes()).toHaveLength(0);
      });
    }

    it.each(["41", "42"])(
      "FR-04-%s duplicate source parameters are not first-wins or last-wins",
      async (duplicate) => {
        const f = await fixture();
        const url = new URL(await f.reuseUrl(renderer), f.origin);
        url.searchParams.append(
          [...url.searchParams].find(([, value]) => value === "41")![0],
          duplicate,
        );
        f.clearCalls();
        const response = await f.get(renderer, url.pathname + url.search);
        const recovered = await f.followRecovery(renderer, response);
        expect(formValues(newForm(recovered.html)).title).toBe("");
        expect(
          recovered.honest,
          "FR-04 ambiguous-source: reject duplicate source values before reading",
        ).toBe(true);
        expect(f.reads()).toHaveLength(0);
        expect(f.writes()).toHaveLength(0);
      },
    );

    it("FR-05 deleted source recovers honestly, not as a successful blank copy", async () => {
      const f = await fixture();
      const url = await f.reuseUrl(renderer);
      f.removeSource();
      const response = await f.get(renderer, url);
      const recovered = await f.followRecovery(renderer, response);
      expect(formValues(newForm(recovered.html)).title).toBe("");
      expect(
        recovered.honest,
        "FR-05 missing-source: explain missing/deleted content or redirect to empty new form",
      ).toBe(true);
      expect(f.reads()).toHaveLength(1);
      expect(f.writes()).toHaveLength(0);
    });

    it("FR-06 classified source-read outage is unavailable, never a blank 200", async () => {
      const f = await fixture();
      const url = await f.reuseUrl(renderer);
      f.failRead();
      const response = await f.get(renderer, url);
      expect(
        response.status,
        "FR-06 outage-as-success: map classified read failure to unavailable",
      ).toBe(503);
      const html = await response.text();
      expect(html).not.toContain(editorial.title);
      expect(response.headers.get("cache-control")).toContain("no-store");
      expect(f.reads()).toHaveLength(1);
      expect(f.writes()).toHaveLength(0);
    });

    it("FR-07 upper serial bound is admitted as an ID, not rejected or truncated", async () => {
      const source = { ...sourceRow(), id: 2147483647 };
      const f = await fixture(source);
      const response = await f.get(renderer, await f.reuseUrl(renderer, source.id));
      expect(response.status).toBe(200);
      expect(formValues(newForm(await response.text())).title).toBe(editorial.title);
      expect(f.reads()).toHaveLength(1);
      expect(f.reads()[0]?.params).toContain(2147483647);
      expect(f.writes()).toHaveLength(0);
    });

    it("FR-08 hostile saved text remains inert and round-trips literally in controls", async () => {
      const hostile =
        '</textarea><img src=x onerror="globalThis.reuseInjected=1"><script>globalThis.reuseInjected=1</script>&';
      const f = await fixture({ ...sourceRow(), title: hostile, body: hostile, imageAlt: hostile });
      const response = await f.get(renderer, await f.reuseUrl(renderer));
      const form = newForm(await response.text());
      expect(formValues(form)).toMatchObject({ title: hostile, body: hostile, image_alt: hostile });
      expect(form.querySelector("img, script, [onerror]")).toBeNull();
      expect(f.writes()).toHaveLength(0);
    });

    it("FR-09 explicit Create uses the displayed draft even after source changes or deletion", async () => {
      const f = await fixture();
      const response = await f.get(renderer, await f.reuseUrl(renderer));
      const form = newForm(await response.text());
      const values = formValues(form);
      expect(
        values.title,
        "FR-09 missing-prefill: cannot verify creation from an absent draft",
      ).toBe(editorial.title);
      values.title = "Moderator's revised headline";
      f.removeSource();
      f.clearCalls();
      const created = await f.post(form.getAttribute("action")!, values);
      expect(created.status).toBe(303);
      expect(created.headers.get("location")).toBe("/admin/featured/9001");
      expect(f.reads()).toHaveLength(0);
      expect(f.created()).toMatchObject({
        id: 9001,
        title: values.title,
        body: editorial.body,
        url: editorial.url,
        imageUrl: editorial.image_url,
        imageAlt: editorial.image_alt,
        position: 0,
        isPublished: false,
        startsAt: null,
        endsAt: null,
        createdBy: f.actorId,
        legacyId: null,
      });
      expect(f.created()?.createdAt).not.toEqual(sourceRow().createdAt);
      expect(f.created()?.updatedAt).not.toEqual(sourceRow().updatedAt);
      expect(f.writes().map((q) => q.table)).toEqual(["featured_contents", "activity_log"]);
      expect(f.audit()).toMatchObject({
        subject_type: "FeaturedContent",
        subject_id: "9001",
        causer_id: f.actorId,
        description: `created featured content ${values.title}`,
      });
      expect(f.audit()?.properties).toMatchObject({
        title: { before: null, after: values.title },
        createdBy: { before: null, after: f.actorId },
      });
    });

    it("FR-10 rejected draft survives current image-host validation with associated error", async () => {
      const f = await fixture({
        ...sourceRow(),
        imageUrl: "https://retired-images.example.org/card.png",
      });
      const response = await f.get(renderer, await f.reuseUrl(renderer));
      const form = newForm(await response.text());
      const values = formValues(form);
      expect(
        values.image_url,
        "FR-10 missing-image-prefill: preserve the stored URL for explicit current-policy validation",
      ).toBe("https://retired-images.example.org/card.png");
      values.body = "Unsaved moderator revision";
      f.clearCalls();
      const rejected = await f.post(form.getAttribute("action")!, values);
      expect(rejected.status).toBe(422);
      const draft = newForm(await rejected.text());
      expect(formValues(draft)).toEqual(values);
      expect(draft.hasAttribute("data-event-draft")).toBe(true);
      const field = draft.querySelector('[name="image_url"]')!;
      expect(field.getAttribute("aria-invalid")).toBe("true");
      const ids = field.getAttribute("aria-describedby")!.split(/\s+/);
      expect(
        ids.some((id) =>
          draft.ownerDocument.getElementById(id)?.textContent?.match(/https|host|approved/i),
        ),
      ).toBe(true);
      expect(f.reads()).toHaveLength(0);
      expect(f.writes()).toHaveLength(0);
      expect(f.source()?.title).toBe(editorial.title);
    });

    for (const mode of ["guest", "member"] as const) {
      it(`FR-C02-${mode} admission refuses before any source lookup or existence disclosure`, async () => {
        const f = await fixture();
        const url = await f.reuseUrl(renderer);
        f.clearCalls();
        const response = await f.get(renderer, url, mode);
        expect(response.status).toBe(mode === "guest" ? 302 : 403);
        expect(await response.text()).not.toContain(editorial.title);
        expect(f.reads()).toHaveLength(0);
        expect(f.writes()).toHaveLength(0);
      });
    }
  });
}

describe("featured reuse / existing explicit-create admission", () => {
  it("FR-C07 existing admin-write throttle refuses reuse Create without a source read or content write", async () => {
    const f = await fixture();
    f.limitWrites();
    const response = await f.post("/admin/featured?source=41", { ...editorial, position: "0" });
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("21");
    expect(f.throttleCalls()).toBeGreaterThan(0);
    expect(f.reads()).toHaveLength(0);
    expect(f.writes()).toHaveLength(0);
  });

  it("FR-C08 Kit does not read source while moderator parent admission is pending", async () => {
    const f = await fixture();
    const url = await f.reuseUrl("kit");
    let release!: () => void;
    const admission = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = f.get("kit", url, "moderator", admission);
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settled).toBe(false);
      expect(f.reads()).toHaveLength(0);
      expect(f.writes()).toHaveLength(0);
    } finally {
      release();
      await pending;
    }
  });
  it("FR-C05 ordinary native create reaches the real model and generates the ordinary audit", async () => {
    const f = await fixture();
    const before = structuredClone(f.source());
    const response = await f.post("/admin/featured", {
      ...editorial,
      position: "0",
      starts_at: "",
      ends_at: "",
    });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/admin/featured/9001");
    expect(f.created()).toMatchObject({
      id: 9001,
      title: editorial.title,
      isPublished: false,
      position: 0,
      startsAt: null,
      endsAt: null,
      createdBy: f.actorId,
      legacyId: null,
    });
    expect(f.audit()).toMatchObject({
      subject_type: "FeaturedContent",
      subject_id: "9001",
      causer_id: f.actorId,
      description: `created featured content ${editorial.title}`,
    });
    expect(f.audit()?.properties).toMatchObject({
      title: { before: null, after: editorial.title },
      createdBy: { before: null, after: f.actorId },
    });
    expect(f.reads()).toHaveLength(0);
    expect(f.writes().map((q) => q.table)).toEqual(["featured_contents", "activity_log"]);
    expect(f.source()).toEqual(before);
  });

  it("FR-C06 invalid stored link and changed image policy still reject through native Create", async () => {
    const f = await fixture();
    const response = await f.post("/admin/featured?source=41", {
      ...editorial,
      url: "javascript:alert(1)",
      image_url: "https://retired-images.example.org/card.png",
      position: "0",
      starts_at: "",
      ends_at: "",
    });
    expect(response.status).toBe(422);
    const form = newForm(await response.text());
    expect(formValues(form)).toMatchObject({
      ...editorial,
      url: "javascript:alert(1)",
      image_url: "https://retired-images.example.org/card.png",
    });
    expect(form.querySelector('[name="url"]')?.getAttribute("aria-invalid")).toBe("true");
    expect(form.querySelector('[name="image_url"]')?.getAttribute("aria-invalid")).toBe("true");
    expect(f.reads()).toHaveLength(0);
    expect(f.writes()).toHaveLength(0);
  });
  for (const [id, origin, title, want] of [
    ["FR-C03", "https://evil.example.org", "Saved headline", 403],
    ["FR-C04", "https://example.org", "x".repeat(400_000), 413],
  ] as const) {
    it(`${id} source query cannot bypass origin or body admission`, async () => {
      const f = await fixture();
      const response = await f.post("/admin/featured?source=41", { ...editorial, title }, origin);
      expect(response.status).toBe(want);
      expect(f.throttleCalls()).toBe(0);
      expect(f.reads()).toHaveLength(0);
      expect(f.writes()).toHaveLength(0);
    });
  }
});
