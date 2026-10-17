import "server-only";
import { getRedis } from "../redis";
import { getServerConfig } from "../config";
import { RouteError } from "../http-core";
import { operationFingerprint } from "../quota";
import { cacheResult, readCachedResult } from "../result-cache";
import { runAiOperation } from "../operation";
import { performOperation } from "../operation-core";
import { claimRoute } from "./state";
import { runCascade } from "./cascade-core";
import {
  providerConfigured,
  providerModel,
  callProvider,
  mapProviderError,
} from "./providers";
import { reserveLlmQuota, settleLlmQuota } from "./quota";
import { buildNotesRequest } from "@/lib/notes/prompt";
import { reserveTextTokens } from "@/lib/notes/token-budget";
import {
  openAiNotesPayload,
  openRouterNotesPayload,
  lunaCostMicros,
} from "@/lib/notes/provider-payload";
import {
  LLM_ROUTING_REVISION,
  PROCESSING_REVISION,
  type NotesRequest,
  type NotesOutput,
  type OutlineOutput,
} from "@/lib/shared/processing";
import { LANGUAGE_POLICY_REVISION } from "@/lib/shared/lecture";

export async function routeNotes(input: NotesRequest, owner: string) {
  const fingerprint = operationFingerprint([
    JSON.stringify(input),
    LLM_ROUTING_REVISION,
  ]);
  const id = operationFingerprint([
    owner,
    input.jobId,
    input.mode,
    input.unitId,
    String(input.attempt),
    LLM_ROUTING_REVISION,
  ]);
  const cached = await readCachedResult<{
    ok: true;
    data: NotesOutput | OutlineOutput;
  }>("notes", id, owner, fingerprint);
  if (cached?.ok) return cached.data;
  // A deployment must first recover a previously launched legacy Groq request.
  const oldRevision =
    input.languagePolicy === "original"
      ? `${PROCESSING_REVISION}:${LANGUAGE_POLICY_REVISION}`
      : PROCESSING_REVISION;
  const oldUnit = `${oldRevision}:${input.mode}:${input.unitId}:${input.attempt}:${getServerConfig().GROQ_NOTES_MODEL}`;
  const oldId = operationFingerprint([owner, input.jobId, "notes", oldUnit]);
  const oldFp = operationFingerprint([oldUnit, JSON.stringify(input)]);
  const old = await readCachedResult<{
    ok: boolean;
    data: NotesOutput | OutlineOutput;
    error: {
      status: number;
      code: string;
      message: string;
      retryAt: string | null;
    };
  }>("notes", oldId, owner, oldFp);
  if (old?.ok) return old.data;
  if (
    old &&
    !old.ok &&
    ![
      "PROVIDER_RATE_LIMIT",
      "PROVIDER_AUTH",
      "PROVIDER_ACCESS_DENIED",
      "PROVIDER_MODEL_UNAVAILABLE",
    ].includes(old.error.code)
  )
    throw new RouteError(
      old.error.status,
      old.error.code,
      old.error.message,
      old.error.retryAt,
    );
  if (!old && (await getRedis().get(`proftopdf:v1:operation:notes:${oldId}`)))
    throw new RouteError(
      409,
      "RESULT_UNCERTAIN",
      "La precedente operazione Groq è già stata avviata, ma la cache non è disponibile. Recuperala prima di autorizzare un nuovo tentativo.",
    );
  const legacyIndex = `proftopdf:v1:cache:job:${owner}:${input.jobId}`;
  const route = await claimRoute(
    id,
    fingerprint,
    `${legacyIndex}:deleted`,
    `proftopdf:v2:llm-job:${owner}:${input.jobId}`,
  );
  try {
    const result = await runCascade({
      state: route.state,
      save: route.save,
      cache: async (data) => {
        await cacheResult(
          "notes",
          id,
          owner,
          fingerprint,
          { ok: true, data },
          input.jobId,
        );
      },
      execute: async (provider, round) => {
        if (!providerConfigured(provider))
          throw new RouteError(
            503,
            "LLM_NOT_CONFIGURED",
            "Motore non configurato.",
          );
        const cooldownKey = `proftopdf:v2:cooldown:${provider}`;
        const until = await getRedis().get<number>(cooldownKey);
        if (until && until > Date.now())
          throw new RouteError(
            429,
            "LLM_COOLDOWN",
            "Questo motore richiede una pausa.",
            new Date(until).toISOString(),
          );
        const unit = `${LLM_ROUTING_REVISION}:${id}:${provider}:${round}:${providerModel(provider)}`;
        const legId = operationFingerprint([owner, input.jobId, "notes", unit]);
        const legFingerprint = operationFingerprint([unit, fingerprint]);
        const common = buildNotesRequest(input);
        const maxOutput =
          provider === "openai"
            ? openAiNotesPayload(input).max_output_tokens
            : provider === "openrouter"
              ? openRouterNotesPayload(input).max_tokens
              : common.maxOutput;
        const budget = reserveTextTokens(
          common.messages,
          common.response_format,
          maxOutput,
        );
        const cost =
          provider === "groq" ? common.tokenUpperBound : budget.tokenUpperBound;
        const reserveMicros =
          provider === "openai"
            ? lunaCostMicros(
                Math.ceil(budget.inputTokens * 1.2) + 512,
                maxOutput,
              )
            : 0;
        let actualMicros: number | null = null;
        const invoke = async () => {
          await route.started(route.state);
          const result = await callProvider(provider, input);
          actualMicros = result.micros;
          return {
            data: {
              ...result.data,
              usage: {
                provider,
                model: providerModel(provider),
                leg: round,
                reservedTokens: cost,
                confirmedTokens: result.tokens,
                costMicroUsd: actualMicros,
              },
            },
            actual: result.tokens,
          };
        };
        try {
          if (provider === "groq")
            return await runAiOperation(
              {
                kind: "notes",
                owner,
                jobId: input.jobId,
                unit,
                fingerprint: legFingerprint,
                cost,
              },
              invoke,
            );
          return await performOperation(
            {
              notesReservation: cost,
              read: () =>
                readCachedResult("notes", legId, owner, legFingerprint),
              reserve: () =>
                reserveLlmQuota(
                  provider,
                  legId,
                  legFingerprint,
                  cost,
                  reserveMicros,
                  owner,
                  input.jobId,
                ),
              cache: (value) =>
                cacheResult(
                  "notes",
                  legId,
                  owner,
                  legFingerprint,
                  value,
                  input.jobId,
                ),
              settle: async (tokens) => {
                if (
                  tokens < 0 ||
                  !Number.isSafeInteger(tokens) ||
                  tokens > cost
                )
                  throw new RouteError(
                    503,
                    "USAGE_UNVERIFIED",
                    "Consumo non verificabile.",
                  );
                await settleLlmQuota(
                  provider,
                  legId,
                  legFingerprint,
                  tokens,
                  actualMicros ?? reserveMicros,
                );
              },
              providerError: async (error) => {
                const failure = mapProviderError(error);
                if (error instanceof RouteError && error.diagnostics?.usage)
                  actualMicros = error.diagnostics.usage.costMicroUsd ?? null;
                if (failure.confirmedUsage === 0) actualMicros = 0;
                failure.diagnostics = {
                  stage: "provider",
                  issueCount: 0,
                  issues: [],
                  ...failure.diagnostics,
                  usage: {
                    provider,
                    model: providerModel(provider),
                    leg: round,
                    costMicroUsd: actualMicros,
                    reservedTokens: cost,
                    confirmedTokens: failure.confirmedUsage ?? null,
                  },
                };
                if (failure.code === "LLM_REJECTED" && failure.retryAt)
                  await getRedis().set(
                    cooldownKey,
                    Date.parse(failure.retryAt),
                    {
                      ex: Math.max(
                        1,
                        Math.ceil(
                          (Date.parse(failure.retryAt) - Date.now()) / 1000,
                        ),
                      ),
                    },
                  );
                return failure;
              },
            },
            invoke,
          );
        } catch (error) {
          if (error instanceof RouteError && error.diagnostics?.usage) {
            error.diagnostics.usage.provider = provider;
            error.diagnostics.usage.model = providerModel(provider);
            error.diagnostics.usage.costMicroUsd =
              provider === "groq"
                ? 0
                : (actualMicros ??
                  error.diagnostics.usage.costMicroUsd ??
                  null);
          }
          throw error;
        }
      },
    });
    await route.release(route.state);
    return result;
  } catch (error) {
    // A missing upstream response keeps the lock poisoned until explicit retry;
    // known invalid/rejected responses are replayable through per-provider cache.
    if (
      error instanceof RouteError &&
      ![
        "RESULT_UNCERTAIN",
        "USAGE_UNVERIFIED",
        "QUOTA_RECONCILIATION_FAILED",
      ].includes(error.code)
    )
      await route.release(route.state).catch(() => {});
    throw error;
  }
}
