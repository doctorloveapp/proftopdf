import "server-only";
import { randomUUID, createHash } from "node:crypto";
import { getServerConfig } from "./config";
import { getRedis } from "./redis";
import { RouteError } from "./http-core";
import {
  QUOTA_RESERVE_LUA,
  QUOTA_SETTLE_LUA,
  RATE_LIMIT_LUA,
} from "./quota-scripts";
import type { QuotaState, QuotaWindow } from "@/lib/shared/types";

type Resource = QuotaWindow["resource"];
interface WindowSpec {
  resource: Resource;
  windowMs: number;
  limit: number;
  cost: number;
}
interface Result {
  kind: "acquired" | "duplicate" | "conflict" | "snapshot" | "denied";
  windows?: (Omit<QuotaWindow, "retryAt"> & { retryAt: number })[];
  retryAt?: number;
  now?: number;
  status?: string;
}
const ROOT = "proftopdf:v1";

export async function enforceRateLimit(
  keys: string[],
  limits: { limit: number; windowMs: number }[],
) {
  const retryAt = await getRedis().eval(
    RATE_LIMIT_LUA,
    keys.map((key) => `${ROOT}:rate:${key}`),
    [JSON.stringify(limits), randomUUID()],
  );
  if (typeof retryAt !== "number")
    throw new Error("Risposta contatore non valida.");
  if (retryAt > 0)
    throw new RouteError(
      429,
      "RATE_LIMIT",
      "Troppe richieste. Attendi prima di riprovare.",
      new Date(retryAt).toISOString(),
    );
}

function profile(kind: "stt" | "notes", cost: number): WindowSpec[] {
  const config = getServerConfig();
  return kind === "stt"
    ? [
        {
          resource: "audio-seconds",
          windowMs: 3_600_000,
          limit: config.STT_AUDIO_SECONDS_PER_HOUR,
          cost,
        },
        {
          resource: "audio-seconds",
          windowMs: 86_400_000,
          limit: config.STT_AUDIO_SECONDS_PER_24H,
          cost,
        },
        { resource: "requests", windowMs: 60_000, limit: 15, cost: 1 },
        { resource: "requests", windowMs: 86_400_000, limit: 1_500, cost: 1 },
      ]
    : [
        {
          resource: "tokens",
          windowMs: 60_000,
          limit: config.LLM_TOKENS_PER_MINUTE,
          cost,
        },
        {
          resource: "tokens",
          windowMs: 86_400_000,
          limit: config.LLM_TOKENS_PER_24H,
          cost,
        },
        { resource: "requests", windowMs: 60_000, limit: 20, cost: 1 },
        { resource: "requests", windowMs: 86_400_000, limit: 800, cost: 1 },
      ];
}
function keys(kind: string, operationId: string, spec: WindowSpec[]) {
  return [
    `${ROOT}:operation:${kind}:${operationId}`,
    ...spec.map(
      (window) => `${ROOT}:quota:${kind}:${window.resource}:${window.windowMs}`,
    ),
  ];
}
function decode(result: unknown): Result {
  const parsed = typeof result === "string" ? JSON.parse(result) : result;
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !["acquired", "duplicate", "conflict", "snapshot", "denied"].includes(
      parsed.kind,
    )
  )
    throw new Error("Risposta quota non valida.");
  return parsed as Result;
}

// Internal API only: callers must verify audio duration or compute the token reservation
// on the server. Never expose a reservation endpoint accepting client costs.
export async function reserveQuota(
  kind: "stt" | "notes",
  operationId: string,
  verifiedCost: number,
  requestFingerprint: string,
) {
  if (!getServerConfig().AI_ENABLED)
    throw new RouteError(
      503,
      "AI_DISABLED",
      "Elaborazione temporaneamente disabilitata.",
    );
  if (
    !/^[a-f0-9]{64}$/.test(operationId) ||
    !/^[a-f0-9]{64}$/.test(requestFingerprint) ||
    !Number.isSafeInteger(verifiedCost) ||
    verifiedCost < 1
  ) {
    throw new RouteError(
      400,
      "INVALID_RESERVATION",
      "Prenotazione non valida.",
    );
  }
  const cost = kind === "stt" ? Math.max(10, verifiedCost) : verifiedCost;
  const spec = profile(kind, cost);
  const result = decode(
    await getRedis().eval(QUOTA_RESERVE_LUA, keys(kind, operationId, spec), [
      JSON.stringify(spec),
      "reserve",
      operationId,
      requestFingerprint,
    ]),
  );
  if (result.kind === "conflict")
    throw new RouteError(
      409,
      "IDEMPOTENCY_CONFLICT",
      "Il contenuto della richiesta è cambiato.",
    );
  if (result.kind === "denied")
    throw new RouteError(
      429,
      "QUOTA_EXHAUSTED",
      "La quota residua non basta per questa richiesta. Il lavoro è salvato e può riprendere all’orario indicato.",
      new Date(result.retryAt!).toISOString(),
      {
        stage: "quota",
        issueCount: 0,
        issues: [],
        quota: (result.windows ?? [])
          .filter(
            (window) =>
              window.remaining < (window.resource === "requests" ? 1 : cost),
          )
          .map((window) => ({
            ...window,
            required: window.resource === "requests" ? 1 : cost,
            retryAt: window.retryAt
              ? new Date(window.retryAt).toISOString()
              : null,
          })),
      },
    );
  return {
    acquired: result.kind === "acquired",
    status: result.status ?? "reserved",
  };
}

export async function settleQuota(
  kind: "stt" | "notes",
  operationId: string,
  fingerprint: string,
  actual: Partial<Record<Resource, number>>,
) {
  const result = await getRedis().eval(
    QUOTA_SETTLE_LUA,
    [`${ROOT}:operation:${kind}:${operationId}`],
    [fingerprint, JSON.stringify(actual)],
  );
  if (result !== "settled" && result !== "duplicate")
    throw new RouteError(
      503,
      "QUOTA_RECONCILIATION_FAILED",
      "Consumo non riconciliato: la prenotazione resta prudenzialmente conteggiata.",
    );
}

export function operationFingerprint(parts: string[]) {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

export async function getQuotaSnapshot(
  kind: "stt" | "notes",
): Promise<QuotaState> {
  const config = getServerConfig();
  const spec = profile(kind, 1);
  const result = decode(
    await getRedis().eval(QUOTA_RESERVE_LUA, keys(kind, "snapshot", spec), [
      JSON.stringify(spec),
      "inspect",
      "",
      "",
    ]),
  );
  return {
    checkedAt: new Date(result.now!).toISOString(),
    provider: "groq",
    model: kind === "stt" ? config.GROQ_STT_MODEL : config.GROQ_NOTES_MODEL,
    available: config.AI_ENABLED && result.kind !== "denied",
    reason: !config.AI_ENABLED
      ? "disabled"
      : result.kind === "denied"
        ? "quota-exhausted"
        : "available",
    windows: (result.windows ?? []).map((window) => ({
      ...window,
      retryAt: window.retryAt ? new Date(window.retryAt).toISOString() : null,
    })),
  };
}
