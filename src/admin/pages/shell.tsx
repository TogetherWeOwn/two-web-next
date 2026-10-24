import { raw } from "hono/html";
// Admin page shell and shared helpers (split from pages.tsx; zero behavior change).
// Shell/TableSortHeader/RsvpAction/Field/val are shared by every admin screen;
// only the historic public names are re-exported through ../pages.

import type { FC, PropsWithChildren } from "hono/jsx";
import { cloneElement, isValidElement } from "hono/jsx";
import { SkipLink } from "../../pages";
import type { EventRow } from "../store";
import type { SortOrder } from "../table-list";

export const TableSortHeader: FC<{
  label: string;
  active: boolean;
  order: SortOrder;
  url: (order: SortOrder) => string;
}> = ({ label, active, order, url }) => {
  const next = active && order === "asc" ? "desc" : "asc";
  return (
    <th scope="col" aria-sort={active ? (order === "asc" ? "ascending" : "descending") : "none"}>
      <a
        href={url(next)}
        aria-label={`Sort by ${label.toLowerCase()} ${next === "asc" ? "ascending" : "descending"}`}
      >
        {label}
        {active ? (order === "asc" ? " ↑" : " ↓") : ""}
      </a>
    </th>
  );
};

export type AdminSection = {
  /** Section root href, e.g. "/admin/events". */
  href: string;
  /** True only when the rendered page IS the section root, never for a descendant. */
  exact: boolean;
};

const ADMIN_SECTIONS = [
  "/admin/events",
  "/admin/featured",
  "/admin/join-attempts",
  "/admin/activity-log",
] as const;

/**
 * Truthful section for an admin path. Exact only on the section root itself;
 * descendants (new/edit/detail, legacy featured-contents URLs) resolve to the
 * ancestor. Boundary-aware: "/admin/events-archive" matches nothing.
 */
export function adminSectionForPath(path: string): AdminSection | null {
  if (path === "/admin" || path === "/admin/") return { href: "/admin", exact: true };
  for (const section of ADMIN_SECTIONS) {
    if (path === section) return { href: section, exact: true };
    if (path.startsWith(`${section}/`)) return { href: section, exact: false };
  }
  if (path === "/admin/featured-contents" || path.startsWith("/admin/featured-contents/"))
    return { href: "/admin/featured", exact: false };
  return null;
}

export const Shell: FC<PropsWithChildren<{ title: string; current?: AdminSection | null }>> = ({
  title,
  current,
  children,
}) => {
  const mark = (href: string): "page" | "location" | undefined =>
    current?.href === href ? (current.exact ? "page" : "location") : undefined;
  return (
    <>
      {raw("<!doctype html>")}
      <html lang="en">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <title>{title} — TWO admin</title>
          <link rel="stylesheet" href="/styles.css" />
        </head>
        <body>
          <SkipLink />
          <header class="bar">
            <a class="brand" href="/admin" aria-current={mark("/admin")}>
              TWO admin
            </a>
            <nav aria-label="Administration">
              <a href="/admin/events" aria-current={mark("/admin/events")}>
                Events
              </a>{" "}
              ·{" "}
              <a href="/admin/featured" aria-current={mark("/admin/featured")}>
                Featured
              </a>{" "}
              ·{" "}
              <a href="/admin/join-attempts" aria-current={mark("/admin/join-attempts")}>
                Join attempts
              </a>{" "}
              ·{" "}
              <a href="/admin/activity-log" aria-current={mark("/admin/activity-log")}>
                Activity log
              </a>{" "}
              · <a href="/">Site</a>
            </nav>
          </header>
          <main id="main" tabindex={-1}>
            {children}
          </main>
          <footer>Together We Own · moderators only</footer>
        </body>
      </html>
    </>
  );
};

export const ErrorPage: FC<{ heading: string; detail?: string; path?: string }> = ({
  heading,
  detail,
  path,
}) => (
  <Shell title={heading} current={path ? adminSectionForPath(path) : undefined}>
    <section>
      <h1>{heading}</h1>
      {detail ? <p data-testid="error-detail">{detail}</p> : null}
      <p>
        <a href="/admin">Back to the dashboard</a>
      </p>
    </section>
  </Shell>
);

const BREADCRUMB_SECTIONS = {
  "/admin/events": "Events",
  "/admin/featured": "Featured",
} as const;

/**
 * Compact upper-page breadcrumb for the event/featured editors. Fixed routes
 * and fixed labels only: editor titles never appear here, so hostile content
 * cannot select a section or destination. Native anchors, so keyboard/no-JS
 * navigation and the existing beforeunload draft guard apply unchanged.
 */
export const AdminBreadcrumb: FC<{ section: keyof typeof BREADCRUMB_SECTIONS }> = ({ section }) => (
  <nav class="crumbs" aria-label="Breadcrumb">
    <a href="/admin">Dashboard</a>
    <span aria-hidden="true"> / </span>
    <a href={section}>{BREADCRUMB_SECTIONS[section]}</a>
  </nav>
);

export const RsvpAction: FC<{ row: EventRow }> = ({ row }) => {
  if (row.status !== "published" || row.endsAt <= new Date()) return null;
  const action = row.rsvpOpen ? "rsvp-pause" : "rsvp-reopen";
  return (
    <form method="post" action={`/admin/events/${row.eventKey}/${action}`}>
      <button type="submit" class="link" data-testid={action}>
        {row.rsvpOpen ? "Pause RSVPs" : "Reopen RSVPs"}
      </button>
    </form>
  );
};

type FieldProps = {
  name: string;
  label: string;
  errors: Record<string, string>;
  hint?: string;
  children: (id: string) => unknown;
};

/**
 * Merge association tokens, dropping exact duplicates so re-wiring is idempotent.
 */
const mergeDescribedBy = (existing: unknown, added: string): string => {
  const tokens = [...String(existing ?? "").split(/\s+/), ...added.split(/\s+/)].filter(Boolean);
  return [...new Set(tokens)].join(" ");
};

/**
 * Shared admin field wrapper. Field owns hint/error association: it mints ids
 * for its hint and error nodes and merges them into the child input's
 * `aria-describedby` (appended after any inline wiring, never clobbering it),
 * plus `aria-invalid` when an error is present. Consumers pass a bare control.
 */
export const Field: FC<FieldProps> = ({ name, label, errors, hint, children }) => {
  const err = errors[name];
  const id = `f-${name.replace(/[^a-z0-9]+/gi, "-")}`;
  const owned = [hint ? `${id}-hint` : "", err ? `${id}-error` : ""].filter(Boolean).join(" ");
  const node = children(id);
  const control =
    owned && isValidElement(node)
      ? cloneElement(node, {
          "aria-invalid": err ? "true" : undefined,
          "aria-describedby": mergeDescribedBy(node.props["aria-describedby"], owned),
        })
      : node;
  return (
    <div class="field">
      <label for={id}>{label}</label>
      {control}
      {hint ? (
        <p id={`${id}-hint`} class="hint">
          {hint}
        </p>
      ) : null}
      {err ? (
        <p id={`${id}-error`} class="error" role="alert" data-testid={`error-${name}`}>
          {err}
        </p>
      ) : null}
    </div>
  );
};

export const val = (values: Record<string, unknown>, name: string): string => {
  const v = values[name];
  return typeof v === "string" ? v : "";
};
