import "server-only";
import { getRedis } from "./redis";
import { CACHE_RESULT_LUA } from "./cache-script";

interface CachedResult {
  owner: string;
  fingerprint: string;
  value: unknown;
}
function cacheKey(
  kind: "stt" | "notes",
  operationId: string,
  owner: string,
  fingerprint: string,
) {
  if (
    ![operationId, owner, fingerprint].every((value) =>
      /^[a-f0-9]{64}$/.test(value),
    )
  )
    throw new Error("Identificativo cache non valido.");
  return `proftopdf:v1:cache:${kind}:${owner}:${operationId}`;
}
// Internal only; owner and fingerprint are derived by the authenticated server.
// Bounded to 500 * 48 KB (< 24 MB payload), below the planned 32 MB cache budget.
export async function cacheResult(
  kind: "stt" | "notes",
  operationId: string,
  owner: string,
  fingerprint: string,
  value: unknown,
) {
  const key = cacheKey(kind, operationId, owner, fingerprint);
  const payload = JSON.stringify({ owner, fingerprint, value });
  if (Buffer.byteLength(payload, "utf8") > 48_000) return false;
  return (
    (await getRedis().eval(
      CACHE_RESULT_LUA,
      ["proftopdf:v1:cache:index", key],
      [payload],
    )) === 1
  );
}
export async function readCachedResult<T>(
  kind: "stt" | "notes",
  operationId: string,
  owner: string,
  fingerprint: string,
): Promise<T | null> {
  const cached = await getRedis().get<CachedResult>(
    cacheKey(kind, operationId, owner, fingerprint),
  );
  return cached && cached.owner === owner && cached.fingerprint === fingerprint
    ? (cached.value as T)
    : null;
}
