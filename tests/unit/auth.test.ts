import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createSessionToken,
  readSessionToken,
  credentialRevision,
  equalSecret,
  sessionCookieOptions,
} from "../../src/lib/server/auth-crypto";
import {
  assertSameOrigin,
  readSmallJson,
  RouteError,
} from "../../src/lib/server/http-core";

const secret = "synthetic-secret-for-session-testing",
  revision = credentialRevision("test-password", secret);
test("Session signatures reject tampering, key rotation and password rotation", () => {
  const { id, token } = createSessionToken(secret, revision);
  assert.equal(readSessionToken(token, secret, revision), id);
  assert.equal(
    readSessionToken(
      `${token.slice(0, -1)}${token.endsWith("a") ? "b" : "a"}`,
      secret,
      revision,
    ),
    null,
  );
  assert.equal(readSessionToken(token, "another-secret", revision), null);
  assert.equal(
    readSessionToken(token, secret, credentialRevision("new-password", secret)),
    null,
  );
  assert.equal(readSessionToken("invalid", secret, revision), null);
});
test("Passwords are exact, and cookie policy requires HTTPS and HttpOnly", () => {
  assert(equalSecret(" keep spaces ", " keep spaces ", secret));
  assert(!equalSecret("keep spaces", " keep spaces ", secret));
  assert(!equalSecret("", "test-password", secret));
  assert.equal(sessionCookieOptions.secure, true);
  assert.equal(sessionCookieOptions.httpOnly, true);
  assert.equal(sessionCookieOptions.sameSite, "strict");
  assert.equal(sessionCookieOptions.path, "/");
});
test("Mutation origin requires exact production origin, even without Fetch Metadata", () => {
  const origin = "https://proftopdf.velodent.eu";
  assert.doesNotThrow(() =>
    assertSameOrigin(
      new Request(origin, { headers: { Origin: origin } }),
      origin,
    ),
  );
  const invalidHeaders: Record<string, string>[] = [
    {},
    { Origin: "https://evil.test" },
    { Origin: origin, "sec-fetch-site": "cross-site" },
  ];
  for (const headers of invalidHeaders)
    assert.throws(
      () => assertSameOrigin(new Request(origin, { headers }), origin),
      RouteError,
    );
});
test("Body size is enforced without trusting Content-Length", async () => {
  const request = new Request("https://proftopdf.velodent.eu", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: "x".repeat(3000) }),
  });
  await assert.rejects(
    () => readSmallJson(request),
    (error: unknown) => error instanceof RouteError && error.status === 413,
  );
  await assert.rejects(
    () =>
      readSmallJson(
        new Request("https://proftopdf.velodent.eu", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{broken",
        }),
      ),
    (error: unknown) => error instanceof RouteError && error.status === 400,
  );
});
