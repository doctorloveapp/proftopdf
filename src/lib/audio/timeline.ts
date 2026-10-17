import { sha256 } from "@noble/hashes/sha2.js";
import { AUDIO_LIMITS } from "@/lib/shared/constants";
import type { AudioSourcePart } from "@/lib/shared/types";

export const MAX_AUDIO_PARTS = 50;
const names = new Intl.Collator("it", { numeric: true, sensitivity: "base" });
export function orderAudioFiles(files: readonly File[]): File[] {
  return [...files].sort(
    (a, b) => a.lastModified - b.lastModified || names.compare(a.name, b.name),
  );
}
/** Keep the user's existing order. Only each newly added group is sorted.
 * Metadata deduplication is a UI safeguard, not a content-identity check. */
export function appendAudioFiles(
  existing: readonly File[],
  incoming: readonly File[],
) {
  const key = (file: File) =>
    JSON.stringify([file.name, file.size, file.lastModified]);
  const seen = new Set(existing.map(key));
  const added: File[] = [];
  for (const file of orderAudioFiles(incoming)) {
    if (seen.has(key(file))) continue;
    seen.add(key(file));
    added.push(file);
  }
  return {
    files: [...existing, ...added],
    duplicates: incoming.length - added.length,
  };
}
export function validateAudioSelection(files: readonly File[]) {
  if (!files.length) throw new Error("Scegli almeno una registrazione.");
  if (files.length > MAX_AUDIO_PARTS)
    throw new Error(
      `Puoi scegliere al massimo ${MAX_AUDIO_PARTS} spezzoni per lezione.`,
    );
  if (
    files.reduce((sum, file) => sum + file.size, 0) > AUDIO_LIMITS.maxFileBytes
  )
    throw new Error(
      "Le registrazioni superano il limite complessivo di 120 MB.",
    );
}
export function virtualTimeline(
  parts: Omit<AudioSourcePart, "index" | "startSeconds">[],
): AudioSourcePart[] {
  let offset = 0;
  const result = parts.map((part, index) => {
    if (!Number.isFinite(part.durationSeconds) || part.durationSeconds <= 0)
      throw new Error(
        "Impossibile determinare la durata di uno spezzone audio.",
      );
    const entry = { ...part, index, startSeconds: offset };
    offset += part.durationSeconds;
    return entry;
  });
  if (offset > AUDIO_LIMITS.maxDurationSeconds)
    throw new Error(
      "Le registrazioni superano il limite complessivo di 120 minuti.",
    );
  return result;
}
/** Order and content define identity; OS timestamps and filenames may change
 * during reselection and must not invalidate the same original recordings. */
export function timelineFingerprint(
  parts: Pick<AudioSourcePart, "sha256" | "byteLength">[],
) {
  if (parts.length === 1) return parts[0].sha256; // legacy single-file identity
  return Array.from(
    sha256(
      new TextEncoder().encode(
        JSON.stringify(parts.map((p) => [p.sha256, p.byteLength])),
      ),
    ),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}
