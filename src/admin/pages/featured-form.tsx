// Admin featured-form screen: new and edit (split from pages.tsx; zero behavior change).

import type { FC } from "hono/jsx";
import { currentlyVisible, FeaturedStatusBadge } from "../../featured-status";
import { FeaturedContentItem } from "../../pages";
import type { FeaturedRow } from "../store";
import { Field, Shell, val } from "./shell";

export const FeaturedFormPage: FC<{
  mode: "new" | "edit";
  row?: FeaturedRow;
  values: Record<string, unknown>;
  errors: Record<string, string>;
  now?: Date;
  appUrl: string;
  imageHosts?: string;
}> = ({ mode, row, values, errors, now = new Date(), appUrl, imageHosts }) => {
  const action = mode === "new" ? "/admin/featured" : `/admin/featured/${row!.id}`;
  const checked =
    values.is_published === "on" || values.is_published === true || values.is_published === "true";
  return (
    <Shell title={mode === "new" ? "New featured slot" : `Edit ${row!.title}`}>
      <section class="featured-form">
        <h1>{mode === "new" ? "New featured slot" : `Edit ${row!.title}`}</h1>
        {mode === "edit" && row ? (
          <section
            class="featured-preview"
            aria-labelledby="featured-preview-heading"
            data-testid="featured-preview"
          >
            <h2 id="featured-preview-heading">Homepage preview</h2>
            <p>
              Last saved content, checked at{" "}
              <time datetime={now.toISOString()}>{now.toISOString()}</time> (UTC). Save changes to
              refresh this preview.
            </p>
            <p>
              Status: <FeaturedStatusBadge row={row} now={now} />
            </p>
            {currentlyVisible(row, now) ? (
              <FeaturedContentItem row={row} appUrl={appUrl} imageHosts={imageHosts} />
            ) : (
              <p data-testid="featured-preview-hidden">
                This slot is not currently visible on the homepage.
              </p>
            )}
          </section>
        ) : null}
        {Object.keys(errors).length > 0 ? (
          <p class="notice" role="alert" data-testid="form-errors">
            Check the highlighted fields and try again.
          </p>
        ) : null}
        <form
          method="post"
          action={action}
          data-event-editor=""
          data-event-draft={Object.keys(errors).length > 0 ? "" : undefined}
        >
          <Field name="title" label="Headline" errors={errors}>
            {(id) => (
              <input
                id={id}
                name="title"
                type="text"
                value={val(values, "title")}
                maxlength={255}
                required
              />
            )}
          </Field>
          <Field name="body" label="Body" errors={errors}>
            {(id) => (
              <textarea id={id} name="body" rows={4}>
                {val(values, "body")}
              </textarea>
            )}
          </Field>
          <Field name="url" label="Link (full http(s) URL, or empty)" errors={errors}>
            {(id) => <input id={id} name="url" type="url" value={val(values, "url")} />}
          </Field>
          <Field
            name="image_url"
            label="Image URL"
            errors={errors}
            hint="HTTPS URL on cdn.discordapp.com or a configured approved public host. Other image hosts are blocked by the site's security policy."
          >
            {(id) => <input id={id} name="image_url" type="url" value={val(values, "image_url")} />}
          </Field>
          <Field
            name="image_alt"
            label="Image description"
            errors={errors}
            hint="Required when an image URL is set — one plain sentence for screen-reader visitors."
          >
            {(id) => (
              <input
                id={id}
                name="image_alt"
                type="text"
                value={val(values, "image_alt")}
                maxlength={255}
              />
            )}
          </Field>
          <div class="field">
            <label for="f-is-published">Published</label>
            <input id="f-is-published" name="is_published" type="checkbox" checked={checked} />
          </div>
          <Field name="position" label="Position (lower appears first)" errors={errors}>
            {(id) => (
              <input
                id={id}
                name="position"
                type="text"
                inputmode="numeric"
                value={val(values, "position") || "0"}
              />
            )}
          </Field>
          <Field
            name="starts_at"
            label="Show from (UTC, YYYY-MM-DD HH:mm[:ss[.ffffff]], or empty)"
            errors={errors}
          >
            {(id) => (
              <input id={id} name="starts_at" type="text" value={val(values, "starts_at")} />
            )}
          </Field>
          <Field
            name="ends_at"
            label="Show until (UTC, YYYY-MM-DD HH:mm[:ss[.ffffff]], or empty)"
            errors={errors}
          >
            {(id) => <input id={id} name="ends_at" type="text" value={val(values, "ends_at")} />}
          </Field>
          <div class="actions">
            <button type="submit" class="btn" data-testid="save-featured">
              {mode === "new" ? "Create" : "Save"}
            </button>
            <a href="/admin/featured">Cancel</a>
          </div>
        </form>
        {mode === "edit" ? (
          <form method="post" action={`/admin/featured/${row!.id}/delete`}>
            <div class="actions">
              <button type="submit" class="link" data-testid="delete-featured">
                Delete this slot
              </button>
            </div>
          </form>
        ) : null}
      </section>
      <script src="/islands/admin-event-editor.js" defer />
    </Shell>
  );
};
