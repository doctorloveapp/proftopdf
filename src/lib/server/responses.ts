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
          "Servizio temporaneamente non disponibile. Il lavoro salvato resta disponibile; recupera il risultato prima di riprovare.",
        );
  const response = privateJson(
    {
      ok: false,
      error: {
        code: known.code,
        message: known.message,
        recoverable: [409, 429, 502, 503, 504].includes(known.status),
        retryAt: known.retryAt,
        ...(known.diagnostics ? { diagnostics: known.diagnostics } : {}),
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
