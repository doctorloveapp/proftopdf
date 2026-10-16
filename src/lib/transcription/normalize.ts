import { z } from "zod";
import type { ChunkTranscript } from "@/lib/shared/processing";
import { RouteError } from "@/lib/server/http-core";

const responseSchema = z.object({
  text: z.string().max(24000),
  duration: z.number().positive(),
  segments: z
    .array(
      z.object({
        start: z.number().nonnegative(),
        end: z.number().nonnegative(),
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
    );
  const data = parsed.data;
  if (
    Math.abs(data.duration - measuredDuration) > 1
  )
    throw new RouteError(
      502,
      "TRANSCRIPTION_DURATION",
      "La durata riconosciuta non corrisponde al segmento inviato. Il risultato richiede un recupero mirato.",
    );
  const segments: ChunkTranscript["segments"] = [];
  let last = 0,
    total = 0;
  for (const item of data.segments ?? []) {
    const text = item.text.trim();
    if (!text) continue;
    if (
      item.end < item.start ||
      item.start < last - 0.1 ||
      item.end > data.duration + 1
    )
      throw new RouteError(
        502,
        "TRANSCRIPTION_TIMESTAMPS",
        "La trascrizione contiene tempi non validi.",
      );
    last = item.start;
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
      (item.compression_ratio ?? 0) > 2.4;
    const segment = {
      start: Math.min(item.start, measuredDuration),
      end: Math.min(item.end, measuredDuration),
      text,
      uncertain,
    };
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
  };
  if (new TextEncoder().encode(JSON.stringify(result)).length > 45000)
    throw new RouteError(
      502,
      "TRANSCRIPTION_SIZE",
      "Il risultato supera la dimensione di recupero sicura.",
    );
  return result;
}
