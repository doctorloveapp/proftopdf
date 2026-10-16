import type { NextRequest } from "next/server";
import { createHash } from "node:crypto";
import { toFile } from "groq-sdk";
import { z } from "zod";
import { requireSession } from "@/lib/server/auth";
import { getServerConfig } from "@/lib/server/config";
import { getGroq } from "@/lib/server/groq";
import {
  assertSameOrigin,
  readLimitedBytes,
  RouteError,
} from "@/lib/server/http-core";
import { privateJson, routeError } from "@/lib/server/responses";
import { validateAudioBytes } from "@/lib/server/audio-validation";
import { enforceRateLimit, operationFingerprint } from "@/lib/server/quota";
import { ownerKey, runAiOperation } from "@/lib/server/operation";
import { normalizeTranscription } from "@/lib/transcription/normalize";
import { PROCESSING_REVISION, MAX_ATTEMPTS } from "@/lib/shared/processing";
import {
  LANGUAGE_POLICY_REVISION,
  TRANSCRIPTION_PROFILES,
  transcriptionContext,
} from "@/lib/shared/lecture";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;
const headersSchema = z.object({
  jobId: z.string().uuid(),
  index: z
    .string()
    .min(1)
    .transform(Number)
    .pipe(z.number().int().min(0).max(1500)),
  start: z.string().min(1).transform(Number).pipe(z.number().min(0).max(7200)),
  sha: z.string().regex(/^[a-f0-9]{64}$/),
  source: z.string().regex(/^[a-f0-9]{64}$/),
  attempt: z
    .string()
    .min(1)
    .transform(Number)
    .pipe(
      z
        .number()
        .int()
        .min(0)
        .max(MAX_ATTEMPTS - 1),
    ),
  accurate: z.enum(["true", "false"]),
  profile: z.enum(TRANSCRIPTION_PROFILES).default("general"),
  languageMode: z.enum(["it", "auto"]).default("it"),
});
export async function POST(request: NextRequest) {
  try {
    const config = getServerConfig();
    assertSameOrigin(request, config.APP_ORIGIN);
    const session = await requireSession(request, true);
    await enforceRateLimit(
      [`inference:${session.id}`],
      [{ limit: 90, windowMs: 60_000 }],
    );
    const parsed = headersSchema.safeParse({
      jobId: request.headers.get("x-job-id"),
      index: request.headers.get("x-chunk-index"),
      start: request.headers.get("x-chunk-start"),
      sha: request.headers.get("x-audio-sha256"),
      source: request.headers.get("x-source-sha256"),
      attempt: request.headers.get("x-attempt"),
      accurate: request.headers.get("x-accurate"),
      profile: request.headers.get("x-lecture-profile") ?? undefined,
      languageMode: request.headers.get("x-language-mode") ?? undefined,
    });
    if (!parsed.success)
      throw new RouteError(
        400,
        "INVALID_AUDIO_REQUEST",
        "Metadati del segmento non validi.",
      );
    const input = parsed.data;
    const bytes = await readLimitedBytes(request, config.MAX_CHUNK_BYTES);
    const sha = createHash("sha256").update(bytes).digest("hex");
    if (sha !== input.sha)
      throw new RouteError(
        400,
        "AUDIO_HASH_MISMATCH",
        "Il segmento ricevuto non corrisponde a quello salvato.",
      );
    const audio = await validateAudioBytes(bytes, request.signal);
    if (input.start + audio.duration > 7201)
      throw new RouteError(
        422,
        "AUDIO_RANGE",
        "Tempi del segmento fuori dai limiti.",
      );
    const model = input.accurate ? "whisper-large-v3" : config.GROQ_STT_MODEL;
    // Preserve the old operation identity for paused jobs created before the
    // multilingual policy. A deployment must not repeat an ambiguous inference.
    const unit =
      input.languageMode === "it"
        ? `${PROCESSING_REVISION}:${input.index}:${model}:${input.attempt}`
        : `${PROCESSING_REVISION}:${LANGUAGE_POLICY_REVISION}:${input.profile}:${input.index}:${model}:${input.attempt}`;
    const fingerprint = operationFingerprint([
      unit,
      input.source,
      sha,
      String(input.start),
      String(audio.duration),
      ...(input.languageMode === "it"
        ? ["it"]
        : [LANGUAGE_POLICY_REVISION, input.profile]),
    ]);
    const data = await runAiOperation(
      {
        kind: "stt",
        owner: ownerKey(session),
        jobId: input.jobId,
        unit,
        fingerprint,
        cost: audio.reservedSeconds,
      },
      async () => {
        // No request.signal here: a disconnected client must not discard a result
        // the provider may already have charged. The bounded route caches it.
        const raw = await getGroq().audio.transcriptions.create(
          {
            file: await toFile(bytes, `segment.${audio.extension}`, {
              type: audio.mime,
            }),
            model,
            // New lessons omit language; only legacy jobs retain their exact
            // request settings so a recovery can reuse the old cached result.
            language: input.languageMode === "it" ? "it" : undefined,
            prompt:
              input.languageMode === "auto"
                ? transcriptionContext(input.profile)
                : undefined,
            response_format: "verbose_json",
            timestamp_granularities: ["segment"],
            temperature: 0,
          },
          { timeout: 90_000, maxRetries: 0 },
        );
        const result = normalizeTranscription(raw, audio.duration, sha, model);
        return { data: result, actual: audio.reservedSeconds };
      },
    );
    return privateJson({ ok: true, data });
  } catch (error) {
    return routeError(error);
  }
}
