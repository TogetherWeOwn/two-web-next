import { raw } from "hono/html";
import type { FC } from "hono/jsx";
import { renderTerminalReviewHtml, type TerminalReviewTarget } from "../terminal-review";

export const TerminalReview: FC<TerminalReviewTarget> = (props) =>
  raw(renderTerminalReviewHtml(props));
