import { expect, it } from "vitest";
import { mergeCookies } from "./helpers/cookie-jar";

it("replays both rotated cookie pairs without stale values or response attributes", () => {
  const response = new Response();
  response.headers.append(
    "set-cookie",
    "__Host-two_session=rotated.signature; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=7200",
  );
  response.headers.append(
    "set-cookie",
    "__Host-two_session_status=probe.signature; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=7200",
  );
  expect(
    mergeCookies(
      "__Host-two_session=old.signature; __Host-two_session_status=old-probe.signature; preference=dark",
      response,
    ),
  ).toBe(
    "__Host-two_session=rotated.signature; __Host-two_session_status=probe.signature; preference=dark",
  );
});

it("honors cookie deletion while retaining cookies not emitted by the response", () => {
  const response = new Response();
  response.headers.append("set-cookie", "__Host-two_session=; Path=/; Max-Age=0");
  response.headers.append("set-cookie", "__Host-two_session_status=; Path=/; Max-Age=0");
  expect(
    mergeCookies(
      "__Host-two_session=old.signature; __Host-two_session_status=old-probe.signature; preference=dark",
      response,
    ),
  ).toBe("preference=dark");
  expect(mergeCookies("preference=dark", new Response())).toBe("preference=dark");
});
