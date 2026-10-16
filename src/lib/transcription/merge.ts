import type { AudioManifest, TranscriptSegment } from "@/lib/shared/types";
import type { ChunkTranscript } from "@/lib/shared/processing";
const word = (value: string) =>
  value
    .normalize("NFKC")
    .toLocaleLowerCase("it")
    .replace(/[^\p{L}\p{N}]/gu, "");
export function mergeTranscripts(
  manifest: AudioManifest,
  results: Record<string, ChunkTranscript>,
) {
  const output: TranscriptSegment[] = [];
  for (const chunk of manifest.chunks) {
    const result = results[chunk.id];
    if (!result || result.status === "missing") {
      output.push({
        id: `s${chunk.index}-missing`,
        chunkId: chunk.id,
        startSeconds: chunk.startSeconds,
        endSeconds: chunk.endSeconds,
        text: "[Segmento non trascritto]",
        status: "missing",
      });
      continue;
    }
    for (const [index, segment] of result.segments.entries()) {
      let text = segment.text,
        start = chunk.startSeconds + segment.start;
      const end = Math.min(chunk.endSeconds, chunk.startSeconds + segment.end),
        previous = output.at(-1);
      // Deduplicate only a suffix/prefix at an actual overlapping chunk boundary.
      // Repeated explanations later in the lecture are preserved.
      if (
        previous &&
        previous.chunkId !== chunk.id &&
        start < previous.endSeconds + 0.05 &&
        previous.status !== "missing"
      ) {
        const before = previous.text.split(/\s+/),
          after = text.split(/\s+/);
        const max = Math.min(
          before.length,
          after.length,
          Math.ceil(chunk.overlapSeconds * 6) + 4,
        );
        for (let n = max; n >= 3; n--) {
          if (
            before.slice(-n).map(word).join(" ") ===
            after.slice(0, n).map(word).join(" ")
          ) {
            text = after.slice(n).join(" ");
            start = Math.min(end, Math.max(start, previous.endSeconds));
            break;
          }
        }
      }
      if (text.trim())
        output.push({
          id: `s${chunk.index}-${index}`,
          chunkId: chunk.id,
          startSeconds: start,
          endSeconds: Math.max(start, end),
          text,
          status: segment.uncertain ? "uncertain" : "confirmed",
        });
    }
  }
  return output;
}
export function timestamp(seconds: number) {
  const total = Math.floor(seconds);
  return `${Math.floor(total / 60)
    .toString()
    .padStart(2, "0")}:${(total % 60).toString().padStart(2, "0")}`;
}
export function transcriptText(segments: TranscriptSegment[]) {
  return segments
    .map(
      (s) =>
        `[${timestamp(s.startSeconds)} - ${timestamp(s.endSeconds)}]${s.status === "uncertain" ? " [da verificare]" : ""} ${s.text}`,
    )
    .join("\n\n");
}
