import type { ErrorDiagnostics } from "@/lib/shared/types";
export class RouteError extends Error {
  confirmedUsage?: number;
  constructor(
    public status: number,
    public code: string,
    message: string,
    public retryAt: string | null = null,
    public diagnostics?: ErrorDiagnostics,
  ) {
    super(message);
  }
}

export async function readLimitedBytes(request: Request, maxBytes: number) {
  const declared = Number(request.headers.get("content-length"));
  if (declared > maxBytes)
    throw new RouteError(
      413,
      "BODY_TOO_LARGE",
      "Il segmento audio è troppo grande.",
    );
  if (!request.body)
    throw new RouteError(400, "INVALID_BODY", "Richiesta vuota.");
  const reader = request.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new RouteError(
          413,
          "BODY_TOO_LARGE",
          "Il segmento audio è troppo grande.",
        );
      }
      parts.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return new Uint8Array(Buffer.concat(parts));
}

export function assertSameOrigin(request: Request, origin: string) {
  if (
    request.headers.get("origin") !== origin ||
    request.headers.get("sec-fetch-site") === "cross-site"
  ) {
    throw new RouteError(
      403,
      "INVALID_ORIGIN",
      "Richiesta non consentita. Ricarica la pagina dal sito ProfToPdf.",
    );
  }
}

export async function readSmallJson(
  request: Request,
  maxBytes = 2_048,
): Promise<unknown> {
  if (
    request.headers.get("content-type")?.split(";")[0].trim() !==
    "application/json"
  ) {
    throw new RouteError(
      415,
      "INVALID_CONTENT_TYPE",
      "Formato della richiesta non valido.",
    );
  }
  const declared = Number(request.headers.get("content-length"));
  if (declared > maxBytes)
    throw new RouteError(413, "BODY_TOO_LARGE", "Richiesta troppo grande.");
  if (!request.body)
    throw new RouteError(400, "INVALID_BODY", "Richiesta vuota.");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new RouteError(413, "BODY_TOO_LARGE", "Richiesta troppo grande.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new RouteError(400, "INVALID_JSON", "Richiesta non valida.");
  }
}
