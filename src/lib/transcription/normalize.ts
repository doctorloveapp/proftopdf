import { z } from "zod";
import type { ChunkTranscript } from "@/lib/shared/processing";
import { RouteError } from "@/lib/server/http-core";

const responseSchema = z.object({
  text: z.string().max(24000),
  duration: z.number().positive(),
  segments: z
    .array(
      z.object({
        start: z.number(),
        end: z.number(),
        text: z.string(),
        avg_logprob: z.number().optional(),
        no_speech_prob: z.number().optional(),
        compression_ratio: z.number().optional(),
      }),
    )
    .max(1000)
    .optional(),
});
export function normalizeTranscription(
  raw: unknown,
  measuredDuration: number,
  sha256: string,
  model: string,
): ChunkTranscript {
  const parsed = responseSchema.safeParse(raw);
  if (!parsed.success)
    throw new RouteError(
      502,
      "TRANSCRIPTION_INVALID",
      "Il servizio ha restituito una trascrizione incompleta o non valida.",
      null,
      {
        stage: "structure",
        issueCount: parsed.error.issues.length,
        issues: parsed.error.issues.slice(0, 10).map((issue) => ({
          path: issue.path.join("."),
          code: issue.code,
        })),
      },
    );
  const data = parsed.data;
  if (Math.abs(data.duration - measuredDuration) > 1)
    throw new RouteError(
      502,
      "TRANSCRIPTION_DURATION",
      "La durata riconosciuta non corrisponde al segmento inviato. Il risultato richiede un recupero mirato.",
      null,
      {
        stage: "provider",
        issueCount: 1,
        issues: [{ path: "duration", code: "duration_mismatch" }],
        transcription: {
          measuredSeconds: measuredDuration,
          providerSeconds: data.duration,
        },
      },
    );
  const segments: ChunkTranscript["segments"] = [];
  const issues: NonNullable<ChunkTranscript["timing"]>["issues"] = [];
  let issueCount = 0,
    invalidTiming = false;
  let last = 0,
    total = 0;
  for (const [index, item] of (data.segments ?? []).entries()) {
    const text = item.text.trim();
    if (!text) continue;
    const reason =
      item.start < 0 || item.end < 0
        ? "negative"
        : item.end < item.start
          ? "reversed"
          : item.start < last - 0.1
            ? "out-of-order"
            : item.end > data.duration + 1 || item.start > measuredDuration
              ? "beyond-duration"
              : item.end > measuredDuration || item.start < last
                ? "clamped"
                : null;
    if (reason) {
      issueCount++;
      if (issues.length < 10)
        issues.push({ index, reason, start: item.start, end: item.end });
      if (reason !== "clamped") invalidTiming = true;
    }
    total += text.length;
    if (total > 24000)
      throw new RouteError(
        502,
        "TRANSCRIPTION_SIZE",
        "Trascrizione troppo lunga per un singolo segmento.",
      );
    const uncertain =
      (item.avg_logprob ?? 0) < -1 ||
      (item.no_speech_prob ?? 0) > 0.6 ||
      (item.compression_ratio ?? 0) > 2.4 ||
      Boolean(reason);
    const segment = {
      start: Math.max(
        0,
        Math.min(Math.max(item.start, last), measuredDuration),
      ),
      end: Math.max(
        0,
        Math.min(Math.max(item.start, item.end, last), measuredDuration),
      ),
      text,
      uncertain,
    };
    last = Math.max(last, item.start);
    const previous = segments.at(-1);
    if (
      previous &&
      segment.end - previous.start < 22 &&
      previous.uncertain === uncertain
    ) {
      previous.end = Math.max(previous.end, segment.end);
      previous.text += " " + text;
    } else segments.push(segment);
  }
  if (invalidTiming) {
    // Preserve recognized words without inventing word/sentence timestamps.
    // The whole clip is explicitly uncertain and retains its real audio bounds.
    const text =
      data.text.trim() ||
      (data.segments ?? [])
        .map((s) => s.text.trim())
        .filter(Boolean)
        .join(" ");
    segments.splice(0, segments.length, {
      start: 0,
      end: measuredDuration,
      text: text || "[Nessun parlato rilevato in questo segmento]",
      uncertain: true,
    });
  }
  if (!segments.length && data.text.trim())
    segments.push({
      start: 0,
      end: measuredDuration,
      text: data.text.trim(),
      uncertain: true,
    });
  if (!segments.length)
    segments.push({
      start: 0,
      end: measuredDuration,
      text: "[Nessun parlato rilevato in questo segmento]",
      uncertain: true,
    });
  const result: ChunkTranscript = {
    sha256,
    model,
    durationSeconds: measuredDuration,
    status: "transcribed",
    segments,
    ...(issueCount
      ? {
          timing: {
            mode: invalidTiming ? ("clip" as const) : ("clamped" as const),
            measuredSeconds: measuredDuration,
            providerSeconds: data.duration,
            issueCount,
            issues,
          },
        }
      : {}),
  };
  if (new TextEncoder().encode(JSON.stringify(result)).length > 45000)
    throw new RouteError(
      502,
      "TRANSCRIPTION_SIZE",
      "Il risultato supera la dimensione di recupero sicura.",
    );
  return result;
}
