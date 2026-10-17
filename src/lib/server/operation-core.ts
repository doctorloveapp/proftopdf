import { RouteError } from "./http-core";
import type { ErrorDiagnostics } from "@/lib/shared/types";

interface Failure {
  status: number;
  code: string;
  message: string;
  retryAt: string | null;
  diagnostics?: ErrorDiagnostics;
}
type Outcome<T> = { ok: true; data: T } | { ok: false; error: Failure };
export interface OperationDependencies {
  notesReservation?: number;
  read<T>(): Promise<Outcome<T> | null>;
  reserve(): Promise<{ acquired: boolean; status: string }>;
  cache(value: unknown): Promise<boolean>;
  settle(actual: number): Promise<void>;
  providerError(error: unknown): Promise<RouteError>;
}
// One reservation can start at most one upstream call. A missing response/cache
// never makes that same operation safe to execute a second time.
export async function performOperation<T>(
  dependencies: OperationDependencies,
  provider: () => Promise<{ data: T; actual: number }>,
) {
  const replay = await dependencies.read<T>();
  if (replay) {
    if (replay.ok) return replay.data;
    throw new RouteError(
      replay.error.status,
      replay.error.code,
      replay.error.message,
      replay.error.retryAt,
      replay.error.diagnostics,
    );
  }
  const reservation = await dependencies.reserve();
  if (!reservation.acquired) {
    const cached = await dependencies.read<T>();
    if (cached?.ok) return cached.data;
    if (cached && !cached.ok)
      throw new RouteError(
        cached.error.status,
        cached.error.code,
        cached.error.message,
        cached.error.retryAt,
        cached.error.diagnostics,
      );
    throw new RouteError(
      409,
      "RESULT_UNCERTAIN",
      "Questa richiesta è già stata avviata. Recupera il risultato; se non torna disponibile, autorizza un nuovo tentativo che può consumare altra quota.",
      new Date(Date.now() + 15_000).toISOString(),
    );
  }
  let result: { data: T; actual: number };
  try {
    result = await provider();
  } catch (error) {
    const failure = await dependencies.providerError(error);
    if (dependencies.notesReservation !== undefined) {
      const actual =
        failure.confirmedUsage ??
        (error instanceof RouteError ? error.confirmedUsage : undefined);
      failure.diagnostics = {
        stage: "provider",
        issueCount: 0,
        issues: [],
        ...failure.diagnostics,
        usage: {
          ...failure.diagnostics?.usage,
          reservedTokens: dependencies.notesReservation,
          confirmedTokens:
            Number.isSafeInteger(actual) &&
            actual! >= 0 &&
            actual! <= dependencies.notesReservation
              ? actual!
              : null,
        },
      };
    }
    await dependencies
      .cache({
        ok: false,
        error: {
          status: failure.status,
          code: failure.code,
          message: failure.message,
          retryAt: failure.retryAt,
          ...(failure.diagnostics ? { diagnostics: failure.diagnostics } : {}),
        },
      })
      .catch(() => false);
    // A definitive invalid response may include verified provider usage. Charge
    // that usage, not the entire reservation. Missing/ambiguous usage stays held.
    const confirmed =
      failure.confirmedUsage ??
      (error instanceof RouteError ? error.confirmedUsage : undefined);
    if (Number.isSafeInteger(confirmed) && confirmed! >= 0)
      await dependencies.settle(confirmed!).catch(() => {});
    throw failure;
  }
  // Cache before reconciliation: if Redis fails here, preserve the reservation.
  // A full bounded cache does not invalidate an otherwise successful response.
  await dependencies.cache({ ok: true, data: result.data });
  await dependencies.settle(result.actual);
  return result.data;
}
