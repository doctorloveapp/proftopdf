import type { NextRequest } from "next/server";
import { requireSession } from "@/lib/server/auth";
import { getServerConfig } from "@/lib/server/config";
import { getGroq } from "@/lib/server/groq";
import {
  assertSameOrigin,
  readSmallJson,
  RouteError,
} from "@/lib/server/http-core";
import { privateJson, routeError } from "@/lib/server/responses";
import { enforceRateLimit, operationFingerprint } from "@/lib/server/quota";
import { ownerKey, runAiOperation } from "@/lib/server/operation";
import {
  notesRequestSchema,
  PROCESSING_REVISION,
  utf8Bytes,
} from "@/lib/shared/processing";
import { buildNotesRequest, validateNotesOutput } from "@/lib/notes/request";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;
export async function POST(request: NextRequest) {
  try {
    const config = getServerConfig();
    assertSameOrigin(request, config.APP_ORIGIN);
    const session = await requireSession(request, true);
    await enforceRateLimit(
      [`inference:${session.id}`],
      [{ limit: 90, windowMs: 60_000 }],
    );
    const parsed = notesRequestSchema.safeParse(
      await readSmallJson(request, 16000),
    );
    if (!parsed.success)
      throw new RouteError(
        400,
        "INVALID_NOTES_REQUEST",
        "Unità di testo non valida.",
      );
    const input = parsed.data,
      payload = buildNotesRequest(input);
    if (payload.tokenUpperBound > config.LLM_TOKENS_PER_MINUTE)
      throw new RouteError(
        413,
        "TOKEN_BUDGET",
        "Questa unità supera il budget gratuito. Riduci la dimensione delle unità di testo.",
      );
    const unit = `${PROCESSING_REVISION}:${input.mode}:${input.unitId}:${input.attempt}:${config.GROQ_NOTES_MODEL}`;
    const fingerprint = operationFingerprint([unit, JSON.stringify(input)]);
    const data = await runAiOperation(
      {
        kind: "notes",
        owner: ownerKey(session),
        jobId: input.jobId,
        unit,
        fingerprint,
        cost: payload.tokenUpperBound,
      },
      async () => {
        const response = await getGroq().chat.completions.create(
          {
            model: config.GROQ_NOTES_MODEL,
            messages: payload.messages,
            response_format: payload.response_format,
            max_completion_tokens: payload.maxOutput,
            reasoning_effort: "low",
            temperature: 0.2,
          },
          { timeout: 90_000, maxRetries: 0 },
        );
        const choice = response.choices[0];
        if (
          !choice ||
          choice.finish_reason !== "stop" ||
          !choice.message.content
        )
          throw new RouteError(
            502,
            "NOTES_TRUNCATED",
            "Il modello non ha completato questa unità. Il documento non verrà marcato definitivo.",
          );
        let raw: unknown;
        try {
          raw = JSON.parse(choice.message.content);
        } catch {
          throw new RouteError(
            502,
            "NOTES_INVALID",
            "Risposta appunti non leggibile.",
          );
        }
        const result = validateNotesOutput(input, raw);
        if (utf8Bytes(JSON.stringify(result)) > 44000)
          throw new RouteError(
            502,
            "NOTES_SIZE",
            "Risultato troppo grande per il recupero sicuro.",
          );
        return {
          data: result,
          actual: response.usage?.total_tokens ?? payload.tokenUpperBound,
        };
      },
    );
    return privateJson({ ok: true, data });
  } catch (error) {
    return routeError(error);
  }
}
