export interface SessionInfo {
  authenticated: true;
  csrfToken: string;
  expiresAt: string;
}
export class ClientApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public retryAt: string | null = null,
    public code = "REQUEST_FAILED",
  ) {
    super(message);
  }
}
export async function api<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await fetch(path, {
    credentials: "same-origin",
    cache: "no-store",
    ...options,
  });
  const result = await response.json().catch(() => null);
  if (!response.ok || !result?.ok)
    throw new ClientApiError(
      result?.error?.message ?? "Connessione non disponibile. Riprova.",
      response.status,
      result?.error?.retryAt ?? null,
      result?.error?.code ?? "REQUEST_FAILED",
    );
  return result.data as T;
}
