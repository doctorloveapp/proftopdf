import { RouteError } from "./http-core";

interface Failure {
  status: number;
  code: string;
  message: string;
  retryAt: string | null;
}
type Outcome<T> = { ok: true; data: T } | { ok: false; error: Failure };
export interface OperationDependencies {
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
    await dependencies
      .cache({
        ok: false,
        error: {
          status: failure.status,
          code: failure.code,
          message: failure.message,
          retryAt: failure.retryAt,
        },
      })
      .catch(() => false);
    // Uncertain/failed calls keep their reservation. No automatic paid retry.
    throw failure;
  }
  // Cache before reconciliation: if Redis fails here, preserve the reservation.
  // A full bounded cache does not invalidate an otherwise successful response.
  await dependencies.cache({ ok: true, data: result.data });
  await dependencies.settle(result.actual);
  return result.data;
}
