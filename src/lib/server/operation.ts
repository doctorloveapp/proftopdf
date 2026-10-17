import "server-only";
import { getRedis } from "./redis";
import { cacheResult, readCachedResult } from "./result-cache";
import { reserveQuota, settleQuota, operationFingerprint } from "./quota";
import { RouteError } from "./http-core";
import { performOperation } from "./operation-core";
import { getServerConfig } from "./config";
import { notesProviderError } from "./notes-provider-error";
import type { Session } from "./auth";

export const ownerKey = (session: Session) =>
  operationFingerprint(["owner", session.id]);
const jobIndex = (owner: string, jobId: string) =>
  `proftopdf:v1:cache:job:${owner}:${jobId}`;
export async function invalidateJobCache(owner: string, jobId: string) {
  await getRedis().eval(
    `
local keys=redis.call('SMEMBERS',KEYS[1])
for _,key in ipairs(keys) do redis.call('DEL',key); redis.call('ZREM',KEYS[3],key) end
redis.call('DEL',KEYS[1]); redis.call('SET',KEYS[2],'1','EX',900)
return #keys`,
    [
      jobIndex(owner, jobId),
      `${jobIndex(owner, jobId)}:deleted`,
      "proftopdf:v1:cache:index",
    ],
    [],
  );
  const cascadeIndex = `proftopdf:v2:llm-job:${owner}:${jobId}`;
  await getRedis().eval(
    `
local keys=redis.call('SMEMBERS',KEYS[1]); for _,key in ipairs(keys) do redis.call('DEL',key) end
redis.call('DEL',KEYS[1]); redis.call('SET',KEYS[2],'1','EX',90000); return #keys`,
    [cascadeIndex, `${jobIndex(owner, jobId)}:deleted`],
    [],
  );
}
function retryTime(error: unknown) {
  const headers = (error as { headers?: Headers })?.headers;
  const raw = headers?.get?.("retry-after");
  const seconds = raw && Number.isFinite(Number(raw)) ? Number(raw) : 60;
  const date = raw && !Number.isFinite(Number(raw)) ? Date.parse(raw) : 0;
  return Math.max(
    Date.now() + Math.max(1, Math.min(86400, seconds)) * 1000,
    Number.isFinite(date) ? date : 0,
  );
}
export async function runAiOperation<T>(
  options: {
    kind: "stt" | "notes";
    owner: string;
    jobId: string;
    unit: string;
    fingerprint: string;
    cost: number;
  },
  provider: () => Promise<{ data: T; actual: number }>,
) {
  const { kind, owner, jobId, unit, fingerprint, cost } = options;
  const id = operationFingerprint([owner, jobId, kind, unit]);
  const index = jobIndex(owner, jobId),
    cooldown = `proftopdf:v1:cooldown:${kind}`;
  return performOperation<T>(
    {
      ...(kind === "notes" ? { notesReservation: cost } : {}),
      read: () => readCachedResult(kind, id, owner, fingerprint),
      reserve: async () => {
        // Cache replay precedes this guard, so a deployment changing the token
        // estimate cannot block retrieval of an already completed operation.
        if (kind === "notes" && cost > getServerConfig().LLM_TOKENS_PER_MINUTE)
          throw new RouteError(
            413,
            "TOKEN_BUDGET",
            "Questa unità supera il budget gratuito. Riprendi con unità di testo più piccole.",
          );
        if (await getRedis().get(`${index}:deleted`))
          throw new RouteError(
            410,
            "JOB_DELETED",
            "Questa lezione è stata eliminata.",
          );
        const until = await getRedis().get<number>(cooldown);
        if (until && until > Date.now())
          throw new RouteError(
            429,
            "PROVIDER_COOLDOWN",
            "Il servizio IA richiede una pausa. Il lavoro è salvato.",
            new Date(until).toISOString(),
          );
        return reserveQuota(kind, id, cost, fingerprint);
      },
      cache: (value) => cacheResult(kind, id, owner, fingerprint, value, jobId),
      settle: async (actual) => {
        if (!Number.isSafeInteger(actual) || actual < 0 || actual > cost)
          throw new RouteError(
            503,
            "USAGE_UNVERIFIED",
            "Consumo non verificabile: la prenotazione resta conteggiata.",
          );
        await settleQuota(kind, id, fingerprint, {
          [kind === "stt" ? "audio-seconds" : "tokens"]: actual,
          requests: 1,
        });
      },
      providerError: async (error) => {
        if (error instanceof RouteError) return error;
        const status = (error as { status?: number })?.status;
        const rawCode = (
          error as { error?: { code?: string; error?: { code?: string } } }
        )?.error;
        const code = rawCode?.code ?? rawCode?.error?.code ?? "unknown";
        const knownCodes = [
          "invalid_api_key",
          "model_not_found",
          "model_decommissioned",
          "model_access_denied",
          "terms_acceptance_required",
          "insufficient_quota",
          "rate_limit_exceeded",
        ];
        console.error("[ProfToPdf inference]", {
          kind,
          status: status ?? 0,
          providerCode: knownCodes.includes(code) ? code : "provider-error",
        });
        if (status === 429) {
          const until = retryTime(error);
          await getRedis().set(cooldown, until, {
            ex: Math.max(1, Math.ceil((until - Date.now()) / 1000)),
          });
          return new RouteError(
            429,
            "PROVIDER_RATE_LIMIT",
            "Il servizio IA ha raggiunto il limite gratuito. Il lavoro è salvato; riproveremo dopo l’attesa.",
            new Date(until).toISOString(),
          );
        }
        const notesFailure = notesProviderError(kind, error);
        if (notesFailure) return notesFailure;
        if ([400, 413, 415, 422].includes(status ?? 0))
          return new RouteError(
            422,
            "PROVIDER_INPUT_REJECTED",
            "Il servizio IA ha rifiutato questo segmento. Prova il recupero mirato o un file WAV.",
          );
        if (status === 401)
          return new RouteError(
            503,
            "PROVIDER_AUTH",
            "Groq non accetta la credenziale del server. Il lavoro locale è conservato.",
          );
        if (status === 403)
          return new RouteError(
            503,
            "PROVIDER_ACCESS_DENIED",
            "Groq non autorizza questo modello per l’account. Verifica l’accesso gratuito nella console del provider.",
          );
        if (status === 404)
          return new RouteError(
            503,
            "PROVIDER_MODEL_UNAVAILABLE",
            "Il modello Groq configurato non è disponibile. Il lavoro locale è conservato.",
          );
        return new RouteError(
          503,
          "RESULT_UNCERTAIN",
          "Risposta IA non ricevuta. La richiesta potrebbe essere stata elaborata: recupera il risultato prima di autorizzare un nuovo tentativo.",
          new Date(Date.now() + 15_000).toISOString(),
        );
      },
    },
    provider,
  );
}
