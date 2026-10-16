import type { NextRequest } from "next/server";
import { z } from "zod";
import { getServerConfig } from "@/lib/server/config";
import {
  login,
  publicSession,
  requireSession,
  resolveSession,
  revokeSession,
} from "@/lib/server/auth";
import { SESSION_COOKIE, sessionCookieOptions } from "@/lib/server/auth-crypto";
import {
  assertSameOrigin,
  readSmallJson,
  RouteError,
} from "@/lib/server/http-core";
import { privateJson, routeError } from "@/lib/server/responses";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 20;

export async function GET(request: NextRequest) {
  try {
    const session = await resolveSession(
      request.cookies.get(SESSION_COOKIE)?.value,
    );
    const response = privateJson({
      ok: true,
      data: session ? publicSession(session) : { authenticated: false },
    });
    if (!session)
      response.cookies.set(SESSION_COOKIE, "", {
        ...sessionCookieOptions,
        maxAge: 0,
      });
    return response;
  } catch (error) {
    return routeError(error);
  }
}
export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request, getServerConfig().APP_ORIGIN);
    const parsed = z
      .object({ password: z.string().min(1).max(256) })
      .strict()
      .safeParse(await readSmallJson(request));
    if (!parsed.success)
      throw new RouteError(
        400,
        "INVALID_LOGIN",
        "Inserisci la password di accesso.",
      );
    const result = await login(request, parsed.data.password);
    const response = privateJson({
      ok: true,
      data: publicSession(result.session),
    });
    response.cookies.set(SESSION_COOKIE, result.token, sessionCookieOptions);
    return response;
  } catch (error) {
    return routeError(error);
  }
}
export async function DELETE(request: NextRequest) {
  try {
    assertSameOrigin(request, getServerConfig().APP_ORIGIN);
    await revokeSession(await requireSession(request, true));
    const response = privateJson({ ok: true, data: { authenticated: false } });
    response.cookies.set(SESSION_COOKIE, "", {
      ...sessionCookieOptions,
      maxAge: 0,
    });
    return response;
  } catch (error) {
    return routeError(error);
  }
}
