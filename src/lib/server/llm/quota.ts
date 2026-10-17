import "server-only";
import { getServerConfig } from "../config";
import { getRedis } from "../redis";
import { QUOTA_RESERVE_LUA, QUOTA_SETTLE_LUA } from "../quota-scripts";
import { RouteError } from "../http-core";
import type { LlmProvider, QuotaState, QuotaWindow } from "@/lib/shared/types";
type Provider = Exclude<LlmProvider, "groq">;
function specs(provider: Provider, tokens: number, micros: number) {
  const c = getServerConfig();
  return provider === "openai"
    ? [
        {
          resource: "tokens",
          windowMs: 60000,
          limit: c.OPENAI_TOKENS_PER_MINUTE,
          cost: tokens,
        },
        {
          resource: "micro-usd",
          windowMs: 86400000,
          limit: c.OPENAI_BUDGET_MICRO_USD_PER_24H,
          cost: micros,
        },
      ]
    : [
        {
          resource: "requests",
          windowMs: 60000,
          limit: c.OPENROUTER_REQUESTS_PER_MINUTE,
          cost: 1,
        },
        {
          resource: "requests",
          windowMs: 86400000,
          limit: c.OPENROUTER_REQUESTS_PER_24H,
          cost: 1,
        },
      ];
}
function keys(
  provider: Provider,
  id: string,
  windows: ReturnType<typeof specs>,
) {
  return [
    `proftopdf:v2:operation:${provider}:${id}`,
    ...windows.map(
      (w) => `proftopdf:v2:quota:${provider}:${w.resource}:${w.windowMs}`,
    ),
  ];
}
function decoded(value: unknown): {
  kind: string;
  status?: string;
  now: number;
  retryAt: number;
  windows: (Omit<QuotaWindow, "retryAt"> & { retryAt: number })[];
} {
  const data = typeof value === "string" ? JSON.parse(value) : value;
  if (
    !data ||
    !["acquired", "duplicate", "denied", "snapshot", "conflict"].includes(
      data.kind,
    )
  )
    throw new Error("Risposta quota non valida.");
  return data;
}
export async function reserveLlmQuota(
  provider: Provider,
  id: string,
  fingerprint: string,
  tokens: number,
  micros: number,
  owner: string,
  job: string,
) {
  if (!getServerConfig().AI_ENABLED)
    throw new RouteError(
      503,
      "AI_DISABLED",
      "Le nuove operazioni IA sono disabilitate.",
    );
  const windows = specs(provider, tokens, micros),
    quotaKeys = keys(provider, id, windows);
  if (provider === "openai") {
    windows.push({
      resource: "micro-usd",
      windowMs: 86400000,
      limit: getServerConfig().OPENAI_BUDGET_MICRO_USD_PER_JOB,
      cost: micros,
    });
    quotaKeys.push(`proftopdf:v2:quota:openai:job:${owner}:${job}`);
  }
  const result = decoded(
    await getRedis().eval(QUOTA_RESERVE_LUA, quotaKeys, [
      JSON.stringify(windows),
      "reserve",
      id,
      fingerprint,
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
      "LLM_QUOTA",
      "La capacità residua di questo motore non basta per la richiesta.",
      new Date(result.retryAt).toISOString(),
    );
  return {
    acquired: result.kind === "acquired",
    status: result.status ?? "reserved",
  };
}
export async function settleLlmQuota(
  provider: Provider,
  id: string,
  fingerprint: string,
  tokens: number,
  micros: number,
) {
  const actual =
    provider === "openai" ? { tokens, "micro-usd": micros } : { requests: 1 };
  const result = await getRedis().eval(
    QUOTA_SETTLE_LUA,
    [`proftopdf:v2:operation:${provider}:${id}`],
    [fingerprint, JSON.stringify(actual)],
  );
  if (!["settled", "duplicate"].includes(String(result)))
    throw new RouteError(
      503,
      "QUOTA_RECONCILIATION_FAILED",
      "Consumo non riconciliato: la prenotazione resta conteggiata.",
    );
}
export async function llmQuotaSnapshot(
  provider: Provider,
): Promise<QuotaState> {
  const c = getServerConfig(),
    windows = specs(provider, 1, 1);
  const result = decoded(
    await getRedis().eval(
      QUOTA_RESERVE_LUA,
      keys(provider, "snapshot", windows),
      [JSON.stringify(windows), "inspect", "", ""],
    ),
  );
  const configured = Boolean(
    provider === "openai" ? c.OPENAI_API_KEY : c.OPENROUTER_API_KEY,
  );
  const cooldown = await getRedis().get<number>(
    `proftopdf:v2:cooldown:${provider}`,
  );
  const available =
    c.AI_ENABLED &&
    configured &&
    result.kind !== "denied" &&
    !(cooldown && cooldown > Date.now());
  return {
    checkedAt: new Date(result.now).toISOString(),
    provider,
    model:
      provider === "openai"
        ? "gpt-6-luna"
        : "dots-studio/dots-3-note-preview:free",
    available,
    reason: available
      ? "available"
      : !c.AI_ENABLED
        ? "disabled"
        : !configured || cooldown
          ? "unavailable"
          : "quota-exhausted",
    windows: result.windows.map((w) => ({
      ...w,
      retryAt: w.retryAt ? new Date(w.retryAt).toISOString() : null,
    })),
  };
}
