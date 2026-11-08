import { AUDIO_LIMITS } from "@/lib/shared/constants";
import { AudioProcessingError } from "./errors";

export function segmentArguments(
  start: number,
  span: number,
  copy: boolean,
  extension: string,
) {
  const args = [
    "-hide_banner",
    "-v",
    "error",
    "-ss",
    String(start),
    "-i",
    "/input/source",
    "-t",
    String(span),
    "-map",
    "0:a:0",
    "-vn",
    "-map_metadata",
    "-1",
  ];
  args.push(
    ...(copy
      ? [
          "-c:a",
          "copy",
          "-avoid_negative_ts",
          "make_zero",
          "-fs",
          String(AUDIO_LIMITS.maxChunkBytes + 1),
        ]
      : [
          "-ac",
          "1",
          "-ar",
          "16000",
          "-af",
          "asetpts=PTS-STARTPTS",
          "-c:a",
          "pcm_s16le",
        ]),
  );
  if (copy && extension === "m4a") args.push("-movflags", "+faststart");
  return args;
}

/** Decode bounded PCM chunks, including a small, bounded decoder drain at EOF.
 * Never increase a fractional final chunk to one second or shrink a short
 * decode repeatedly until a single AAC frame happens to fit. */
export function segmentPlan(
  start: number,
  duration: number,
  copy: boolean,
  bitrate: number,
) {
  const remaining = duration - start;
  if (!Number.isFinite(remaining) || remaining <= 0)
    throw new Error("Confini del segmento audio non validi.");
  const limit = copy
    ? Math.min(180, ((AUDIO_LIMITS.maxChunkBytes - 100_000) * 8) / bitrate)
    : 90;
  const final = remaining <= limit;
  return {
    span: Math.min(limit, remaining + (final && !copy ? 0.25 : 0)),
    final,
  };
}

export function segmentEnd(
  start: number,
  duration: number,
  span: number,
  actual: number,
  final: boolean,
) {
  if (
    !Number.isFinite(actual) ||
    actual <= 0 ||
    actual > span + 0.25 ||
    actual + 0.25 < Math.min(span, duration - start)
  )
    throw new AudioProcessingError(
      "AUDIO_SEGMENT_DURATION",
      "segment",
      "La durata decodificata non corrisponde al segmento richiesto. Il lavoro salvato è conservato; esporta il log diagnostico.",
      {
        requestedStart: start,
        requestedSeconds: span,
        actualSeconds: actual,
        sourceSeconds: duration,
        final,
      },
    );
  // AAC edit lists / decoder padding can differ by a frame. Only close EOF
  // after decoding through that boundary; interior chunks keep measured time.
  return final && Math.abs(start + actual - duration) <= 0.25
    ? duration
    : Math.min(duration, start + actual);
}
