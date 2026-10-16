import { NextResponse } from "next/server";
import { RouteError } from "./http-core";

export function privateJson(data: unknown, status = 200) {
  return NextResponse.json(data, {
    status,
    headers: {
      "Cache-Control": "private, no-store, max-age=0",
      Vary: "Cookie",
      Pragma: "no-cache",
    },
  });
}
export function routeError(error: unknown) {
  const known =
    error instanceof RouteError
      ? error
      : new RouteError(
          503,
          "SERVICE_UNAVAILABLE",
          "Servizio temporaneamente non disponibile. Nessuna elaborazione è stata avviata.",
        );
  const response = privateJson(
    {
      ok: false,
      error: {
        code: known.code,
        message: known.message,
        recoverable: known.status === 429 || known.status === 503,
        retryAt: known.retryAt,
      },
    },
    known.status,
  );
  if (known.retryAt)
    response.headers.set(
      "Retry-After",
      String(
        Math.max(1, Math.ceil((Date.parse(known.retryAt) - Date.now()) / 1000)),
      ),
    );
  return response;
}
