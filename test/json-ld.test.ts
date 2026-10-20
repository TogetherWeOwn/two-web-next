// A1: Organization/WebSite identities + Event JSON-LD improvements.
// Pure unit tests: no DB, no network. The builders must keep JSON parseable
// even with adversarial </script> content and must match the visible page.
import { describe, expect, it } from "vitest";
import {
  buildEventNode,
  buildOrganization,
  buildSiteGraph,
  buildWebSite,
  eventJsonLd,
  organizationId,
  safeJsonLd,
  siteJsonLd,
  websiteId,
} from "../src/seo-json-ld";

const APP_URL = "https://next.example.test/";
const BASE = "https://next.example.test";

const eventInput = {
  eventKey: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  title: "Chess night",
  description: "Bring a friend & a board.",
  purpose: null,
  startsAt: new Date("2030-01-10T20:00:00Z"),
  endsAt: new Date("2030-01-10T22:00:00Z"),
  location: "The lobby & voice channel",
  status: "published" as const,
};

function scriptBodies(html: string): string[] {
  return [...html.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)].map(
    (m) => m[1]!,
  );
}

describe("seo-json-ld identities", () => {
  it("uses stable @id values derived from the app URL", () => {
    expect(organizationId(APP_URL)).toBe(`${BASE}/#organization`);
    expect(websiteId(APP_URL)).toBe(`${BASE}/#website`);
    // Trailing-slash APP_URL must not leak a double slash.
    expect(organizationId(BASE)).toBe(organizationId(APP_URL));
    expect(websiteId(BASE)).toBe(websiteId(APP_URL));
  });

  it("builds an Organization node matching the visible site", () => {
    expect(buildOrganization(APP_URL)).toMatchObject({
      "@type": "Organization",
      "@id": `${BASE}/#organization`,
      name: "Together We Own",
      url: BASE,
    });
  });

  it("builds a WebSite node that references the Organization publisher", () => {
    expect(buildWebSite(APP_URL)).toMatchObject({
      "@type": "WebSite",
      "@id": `${BASE}/#website`,
      url: BASE,
      publisher: { "@id": `${BASE}/#organization` },
    });
  });

  it("builds a site graph with both identities and no Person markup", () => {
    const graph = buildSiteGraph(APP_URL);
    expect(graph["@context"]).toBe("https://schema.org");
    const types = (graph["@graph"] as { "@type": string }[]).map((n) => n["@type"]);
    expect(types).toEqual(["Organization", "WebSite"]);
    expect(JSON.stringify(graph)).not.toMatch(/"Person"|attendee/i);
  });

  it("emits a parseable site script block", () => {
    const raw = siteJsonLd(APP_URL);
    expect(raw).not.toContain("</script>");
    const parsed = JSON.parse(raw) as { "@graph": unknown[] };
    expect(parsed["@graph"]).toHaveLength(2);
  });
});

describe("seo-json-ld event node", () => {
  it("adds a stable @id, organizer reference and attendance mode", () => {
    const node = buildEventNode(eventInput, APP_URL);
    const canonical = `${BASE}/e/${eventInput.eventKey}`;
    expect(node).toMatchObject({
      "@type": "Event",
      "@id": canonical,
      url: canonical,
      name: "Chess night",
      organizer: { "@id": `${BASE}/#organization` },
      eventAttendanceMode: "https://schema.org/OnlineEventAttendanceMode",
    });
  });

  it("matches the visible page and carries no attendee markup", () => {
    const node = buildEventNode(eventInput, APP_URL) as Record<string, unknown>;
    expect(node.startDate).toBe("2030-01-10T20:00:00.000Z");
    expect(node.endDate).toBe("2030-01-10T22:00:00.000Z");
    expect(node.description).toBe(eventInput.description);
    expect(node.eventStatus).toBe("https://schema.org/EventScheduled");
    const serialized = JSON.stringify(node);
    expect(serialized).not.toMatch(/"Person"|attendee|performer/i);
    // No attendee names leak into the node.
    expect(serialized).not.toContain("member");
  });

  it("maps cancelled to EventCancelled", () => {
    const node = buildEventNode({ ...eventInput, status: "cancelled" }, APP_URL);
    expect(node.eventStatus).toBe("https://schema.org/EventCancelled");
  });

  it("omits an empty description like the visible page", () => {
    const node = buildEventNode({ ...eventInput, description: "" }, APP_URL);
    expect("description" in node).toBe(false);
  });

  it("keeps a VirtualLocation with the venue name for text locations", () => {
    const node = buildEventNode(eventInput, APP_URL) as {
      location: { "@type": string; url: string; name?: string };
    };
    expect(node.location["@type"]).toBe("VirtualLocation");
    expect(node.location.url).toBe(BASE);
    expect(node.location.name).toBe(eventInput.location);
  });

  it("uses an https location URL directly as the virtual venue", () => {
    const url = "https://discord.gg/invite";
    const node = buildEventNode({ ...eventInput, location: url }, APP_URL) as {
      location: { url: string };
    };
    expect(node.location.url).toBe(url);
  });
});

describe("safeJsonLd", () => {
  it("parses even with adversarial </script> content", () => {
    const hostile = {
      ...eventInput,
      title: 'Chess </script><script>alert("xss")</script>',
      description: "Bring <!-- a board --> & friends   ",
    };
    const raw = eventJsonLd(hostile, APP_URL);
    expect(raw).not.toContain("</script>");
    expect(raw).not.toContain("<!--");
    const parsed = JSON.parse(raw) as { name: string; description: string };
    expect(parsed.name).toBe(hostile.title);
    expect(parsed.description).toBe(hostile.description);
  });

  it("escapes angle brackets and ampersands without breaking JSON", () => {
    const raw = safeJsonLd({ text: '<b>& "friends"</b>' });
    expect(raw).not.toContain("<");
    expect(raw).not.toContain(">");
    expect(JSON.parse(raw)).toEqual({ text: '<b>& "friends"</b>' });
  });
});

describe("eventJsonLd script", () => {
  it("emits a top-level Event block that parses as JSON", () => {
    const raw = eventJsonLd(eventInput, APP_URL);
    expect(raw).not.toContain("</script>");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed["@type"]).toBe("Event");
    expect(parsed["@context"]).toBe("https://schema.org");
  });
});

describe("homepage site identities", () => {
  it("renders a parseable Organization/WebSite block with no Person markup", async () => {
    const { default: app } = await import("./app");
    const res = await app.request("/", {}, {
      APP_URL,
      SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
      DISCORD_INVITE_URL: "https://discord.gg/invite",
    } as never);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('data-testid="site-jsonld"');
    const bodies = scriptBodies(html);
    expect(bodies.length).toBeGreaterThanOrEqual(1);
    const site = JSON.parse(bodies.find((b) => b.includes("WebSite")) ?? bodies[0]!) as {
      "@graph": { "@type": string; "@id": string }[];
    };
    const types = site["@graph"].map((n) => n["@type"]).sort();
    expect(types).toEqual(["Organization", "WebSite"]);
    expect(site["@graph"].map((n) => n["@id"]).sort()).toEqual(
      [`${BASE}/#organization`, `${BASE}/#website`].sort(),
    );
    expect(html).not.toMatch(/"Person"|attendee|performer/i);
  });
});

describe("event page JSON-LD blocks", () => {
  it("parses with adversarial content and matches the visible page", async () => {
    const { getTableColumns } = await import("drizzle-orm");
    const { drizzle } = await import("drizzle-orm/pg-proxy");
    const { default: app } = await import("./app");
    const { events } = await import("../src/db/admin-schema");

    const hostileTitle = 'Chess </script><script>alert("xss")</script>';
    const start = new Date("2030-01-10T20:00:00Z");
    const row = {
      id: 1,
      icsSequence: 1n,
      eventKey: eventInput.eventKey,
      title: hostileTitle,
      game: "Chess",
      description: "Bring a friend & a board.",
      purpose: null,
      startsAt: start,
      endsAt: new Date("2030-01-10T22:00:00Z"),
      timezone: "UTC",
      location: "The lobby & voice channel",
      capacity: 10,
      status: "published",
      rsvpOpen: true,
      discordEventId: null,
      discordSyncFailedAt: null,
      discordSyncFailureCode: null,
      syncRevision: 1,
      syncedRevision: 0,
      agentGrantId: null,
      proofMarker: null,
      agentVersion: 1,
      createdBy: null,
      recurrenceFrequency: null,
      recurrenceCount: null,
      recurrenceEndsOn: null,
      parentEventId: null,
      recurrenceIndex: null,
      createdAt: start,
      updatedAt: start,
    };
    const columns = Object.keys(getTableColumns(events)) as (keyof typeof row)[];
    const db = drizzle(async (sql) => {
      if (sql.includes('from "rsvps"') && sql.includes('inner join "users"')) return { rows: [] };
      if (sql.includes('from "rsvps"')) return { rows: [] };
      if (sql.includes('"event_key" =')) {
        return {
          rows: [
            columns.map((key) =>
              row[key] instanceof Date ? (row[key] as Date).toISOString() : row[key],
            ),
          ],
        };
      }
      return { rows: [] };
    });
    const env = {
      APP_URL,
      SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
      ADMIN_DB: db,
    } as never;
    const res = await app.request(`/e/${eventInput.eventKey}`, {}, env);
    expect(res.status).toBe(200);
    const html = await res.text();
    // The hostile title is visible as text but must never close the script.
    expect(html).toContain("Chess");
    expect(html).not.toContain("</script><script>alert");
    expect(html).toContain('data-testid="event-jsonld"');
    expect(html).toContain('data-testid="site-jsonld"');
    const bodies = scriptBodies(html);
    expect(bodies.length).toBe(2);
    const event = JSON.parse(bodies.find((b) => b.includes('"Event"')) ?? bodies[0]!) as Record<
      string,
      unknown
    >;
    expect(event).toMatchObject({
      "@type": "Event",
      "@id": `${BASE}/e/${eventInput.eventKey}`,
      url: `${BASE}/e/${eventInput.eventKey}`,
      name: hostileTitle,
      organizer: { "@id": `${BASE}/#organization` },
      eventAttendanceMode: "https://schema.org/OnlineEventAttendanceMode",
    });
    // Description matches the visible copy; no attendee data leaks.
    expect(event.description).toBe("Bring a friend & a board.");
    expect(JSON.stringify(event)).not.toMatch(/"Person"|attendee|performer/i);
    const site = JSON.parse(bodies.find((b) => b.includes("WebSite")) ?? bodies[1]!) as {
      "@graph": unknown[];
    };
    expect(site["@graph"]).toHaveLength(2);
  });
});
