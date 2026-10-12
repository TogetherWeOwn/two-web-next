// Shared HTML outcome renderer.
//
// Hono-owned controllers that return HTML recovery or form-validation
// outcomes render through this injected, buffered interface instead of
// calling c.html() directly. The controller supplies a typed model, a status
// and extra headers; the injected renderer turns the model into bytes. The
// bytes are buffered to completion inside the member-read boundary (when one
// is active) and the renderer executes exactly once per outcome object, so a
// re-read never double-renders and a refused audit never leaks a partial body.
//
// Framework-free: the core never imports Hono JSX or Svelte. The default
// Hono adapter lives beside its controller (see src/recovery-outcome.ts); a
// future Svelte SSR adapter supplies the same model shape. Tests inject a
// counting fake to prove single execution and response identity.
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { bufferedMemberHtml } from "./member-reads";

export type HtmlOutcomeBody = string | Promise<string> | unknown;

export interface HtmlOutcomeRendererObject<TModel> {
  render(model: TModel): HtmlOutcomeBody;
}

/** Object with a render method, or a bare render function — both injectable. */
export type HtmlOutcomeRenderer<TModel> =
  | HtmlOutcomeRendererObject<TModel>
  | ((model: TModel) => HtmlOutcomeBody);

export interface HtmlOutcome<TModel> {
  model: TModel;
  renderer: HtmlOutcomeRenderer<TModel>;
  status?: ContentfulStatusCode;
  headers?: Record<string, string>;
}

const rendered = new WeakMap<object, Promise<unknown>>();

function renderOnce<TModel>(outcome: HtmlOutcome<TModel>): Promise<unknown> {
  const key = outcome as unknown as object;
  const hit = rendered.get(key);
  if (hit) return hit;
  const pending = Promise.resolve().then(() =>
    typeof outcome.renderer === "function"
      ? outcome.renderer(outcome.model)
      : outcome.renderer.render(outcome.model),
  );
  rendered.set(key, pending);
  return pending;
}

/**
 * Render one HTML outcome: buffer the injected renderer's bytes, then answer
 * with the controller's status and headers. Extra headers are set on the
 * finished response (never via c.header() pre-render, which would not survive
 * the buffered copy). Never reads sessions or the database itself: offering
 * recovery must work during an outage.
 */
export async function renderHtmlOutcome<TModel>(
  c: Context,
  outcome: HtmlOutcome<TModel>,
): Promise<Response> {
  const body = await renderOnce(outcome);
  const res = await bufferedMemberHtml(c, body as string, outcome.status ?? 200);
  if (outcome.headers) {
    for (const [name, value] of Object.entries(outcome.headers)) {
      res.headers.set(name, value);
    }
  }
  return res;
}
