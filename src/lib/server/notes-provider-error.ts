import { RouteError } from "./http-core";

/** Classify only known provider signals; never include provider text or the
 * failed_generation payload in logs, cache or a user-facing error. */
export function notesProviderError(kind: string, error: unknown) {
  const failure = error as {
    status?: number;
    error?: {
      code?: string;
      failed_generation?: unknown;
      error?: { code?: string; failed_generation?: unknown };
    };
  };
  if (kind !== "notes" || ![400, 413, 415, 422].includes(failure?.status ?? 0))
    return null;
  const detail = failure.error?.error ?? failure.error;
  if (
    detail?.code === "json_validate_failed" ||
    typeof detail?.failed_generation === "string"
  )
    return new RouteError(
      502,
      "NOTES_JSON",
      "Il modello non ha completato un JSON valido per gli appunti. La trascrizione è conservata.",
    );
  return new RouteError(
    422,
    "NOTES_PROVIDER_REJECTED",
    "Il servizio IA ha rifiutato questa richiesta di appunti. Il testo salvato è conservato; esporta il log per verificare il problema.",
  );
}
