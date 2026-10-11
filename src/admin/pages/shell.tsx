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

export const Shell: FC<PropsWithChildren<{ title: string }>> = ({ title, children }) => (
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
        <a class="brand" href="/admin">
          TWO admin
        </a>
        <nav aria-label="Administration">
          <a href="/admin/events">Events</a> · <a href="/admin/featured">Featured</a> ·{" "}
          <a href="/admin/join-attempts">Join attempts</a> ·{" "}
          <a href="/admin/activity-log">Activity log</a> · <a href="/">Site</a>
        </nav>
      </header>
      <main id="main" tabindex={-1}>
        {children}
      </main>
      <footer>Together We Own · moderators only</footer>
    </body>
  </html>
);

export const ErrorPage: FC<{ heading: string; detail?: string }> = ({ heading, detail }) => (
  <Shell title={heading}>
    <section>
      <h1>{heading}</h1>
      {detail ? <p data-testid="error-detail">{detail}</p> : null}
      <p>
        <a href="/admin">Back to the dashboard</a>
      </p>
    </section>
  </Shell>
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
