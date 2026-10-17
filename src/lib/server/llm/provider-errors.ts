import { RouteError } from "../http-core";

/** Received HTTP failures may fail over. Lost responses must not duplicate work.
 * Never expose raw provider messages, generations, keys or headers. */
export function mapProviderError(error: unknown): RouteError {
  if (error instanceof RouteError) return error;
  const status = (error as { status?: number })?.status;
  if (
    status &&
    [400, 401, 402, 403, 404, 429, 500, 502, 503, 504].includes(status)
  ) {
    const headers = (error as { headers?: Headers }).headers;
    const hint = headers?.get("retry-after");
    const code = (error as { code?: string }).code;
    const seconds =
      code === "insufficient_quota" || status === 402
        ? 3600
        : [401, 403, 404].includes(status)
          ? 300
          : 60;
    const parsed =
      hint && Number.isFinite(Number(hint))
        ? Date.now() + Number(hint) * 1000
        : hint
          ? Date.parse(hint)
          : 0;
    const retryAt = new Date(
      Math.max(
        Date.now() + 1000,
        Math.min(Date.now() + 86400000, parsed || Date.now() + seconds * 1000),
      ),
    ).toISOString();
    const failure = new RouteError(
      503,
      "LLM_REJECTED",
      "Il motore degli appunti non è disponibile; passaggio al successivo.",
      retryAt,
    );
    if ([400, 401, 402, 403, 404, 429].includes(status))
      failure.confirmedUsage = 0;
    return failure;
  }
  return new RouteError(
    503,
    "RESULT_UNCERTAIN",
    "Risposta del motore non ricevuta. Recupera la stessa operazione prima di autorizzare un nuovo tentativo.",
    new Date(Date.now() + 15000).toISOString(),
  );
}
