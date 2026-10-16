import { mkdir, writeFile } from "node:fs/promises";
import { NextRequest } from "next/server";
import { POST, GET, DELETE } from "../src/app/api/session/route";
import { GET as quotaGET } from "../src/app/api/quota/route";
import { getRedis } from "../src/lib/server/redis";
import {
  clientAddressKey,
  SESSION_COOKIE,
} from "../src/lib/server/auth-crypto";

process.loadEnvFile(".env");
async function main() {
  const origin = process.env.APP_ORIGIN!,
    password = process.env.APP_ACCESS_PASSWORD!;
  const address = "198.51.100.249";
  const request = (
    method: string,
    cookie = "",
    extra: Record<string, string> = {},
    body?: unknown,
  ) =>
    new NextRequest(`${origin}/api/session`, {
      method,
      headers: {
        Origin: origin,
        "x-forwarded-for": address,
        Cookie: cookie,
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...extra,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  const check = (condition: unknown) => {
    if (!condition) throw new Error("Verifica autenticazione fallita.");
  };
  let cookie = "",
    csrf = "";
  try {
    check(
      (
        await POST(
          request(
            "POST",
            "",
            { Origin: "https://invalid.example" },
            { password },
          ),
        )
      ).status === 403,
    );
    check(
      (
        await POST(
          request("POST", "", {}, { password: "synthetic-invalid-password" }),
        )
      ).status === 401,
    );
    const signedIn = await POST(request("POST", "", {}, { password }));
    check(signedIn.status === 200);
    const header = signedIn.headers.get("set-cookie") ?? "";
    check(
      header.includes("HttpOnly") &&
        header.includes("Secure") &&
        /SameSite=strict/i.test(header) &&
        !header.includes("Domain="),
    );
    const value = signedIn.cookies.get(SESSION_COOKIE)?.value;
    check(value);
    cookie = `${SESSION_COOKIE}=${value}`;
    csrf = (await signedIn.json()).data.csrfToken;
    check(
      (await (await GET(request("GET", cookie))).json()).data.authenticated,
    );
    check((await DELETE(request("DELETE", cookie))).status === 403);
    check(
      (
        await quotaGET(
          new NextRequest(`${origin}/api/quota`, {
            headers: { Cookie: cookie },
          }),
        )
      ).status === 200,
    );
    check(
      (await DELETE(request("DELETE", cookie, { "x-csrf-token": csrf })))
        .status === 200,
    );
    check(
      !(await (await GET(request("GET", cookie))).json()).data.authenticated,
    );
    check(
      (await quotaGET(new NextRequest(`${origin}/api/quota`))).status === 401,
    );
    const report = {
      checkedAt: new Date().toISOString(),
      ok: true,
      exactOriginEnforced: true,
      wrongPasswordRejected: true,
      secureHttpOnlyHostCookie: true,
      sessionRestored: true,
      csrfEnforced: true,
      protectedQuotaReadable: true,
      logoutRevokesSession: true,
      unauthenticatedQuotaRejected: true,
      groqCalls: 0,
      mode: "direct-handler integration, real Redis, no local HTTP server or browser",
    };
    await mkdir("docs", { recursive: true });
    await writeFile(
      "docs/auth-check.json",
      JSON.stringify(report, null, 2) + "\n",
    );
    console.log(JSON.stringify(report, null, 2));
  } finally {
    if (cookie && csrf)
      await DELETE(request("DELETE", cookie, { "x-csrf-token": csrf })).catch(
        () => {},
      );
    await getRedis().del(
      `proftopdf:v1:rate:login:${clientAddressKey(address, process.env.SESSION_SECRET!)}`,
    );
    // The global login counter keeps these two real attempts conservatively.
  }
}
main().catch(() => {
  console.error(
    "Verifica autenticazione non completata. Nessuna credenziale o cookie visualizzato.",
  );
  process.exitCode = 1;
});
