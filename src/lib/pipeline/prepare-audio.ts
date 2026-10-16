import { AUDIO_LIMITS } from "@/lib/shared/constants";
import type { AudioChunk, ProcessingJob } from "@/lib/shared/types";
import { inspectWav, sliceWav, nextChunkStart } from "@/lib/audio/wav";
import { fingerprint, abortIfNeeded } from "@/lib/audio/fingerprint";
import {
  acquireLease,
  renewLease,
  releaseLease,
  savePreparedChunk,
  saveJob,
  getChunk,
  type LocalJob,
} from "@/lib/storage/jobs";

export const AUDIO_ACCEPT = ".m4a,.aac,.mp3,.wav,.flac,.ogg,.webm,.mp4,audio/*";
export function validateFile(file: File) {
  if (file.name.length > 255)
    throw new Error(
      "Il nome del file è troppo lungo. Rinomina la registrazione e riprova.",
    );
  if (!file.size) throw new Error("Il file selezionato è vuoto.");
  if (file.size > AUDIO_LIMITS.maxFileBytes)
    throw new Error("Il file supera il limite di 120 MB.");
  if (!/\.(m4a|aac|mp3|wav|flac|ogg|webm|mp4)$/i.test(file.name))
    throw new Error("Scegli un file M4A, AAC, MP3, WAV, FLAC, Ogg o WebM.");
}
export interface PreparationProgress {
  stage: "analyzing" | "preparing";
  fraction: number | null;
  message: string;
}

export async function prepareAudio(
  file: File,
  local: LocalJob,
  signal: AbortSignal,
  notify: (local: LocalJob, progress: PreparationProgress) => void,
) {
  validateFile(file);
  const token = await acquireLease(local.job.id);
  let current = structuredClone(local);
  const aborter = new AbortController();
  const timer = setInterval(() => {
    renewLease(local.job.id, token).catch(() => aborter.abort());
  }, 5_000);
  const combined = aborter.signal;
  const relayAbort = () => aborter.abort(signal.reason);
  if (signal.aborted) aborter.abort(signal.reason);
  else signal.addEventListener("abort", relayAbort, { once: true });
  let worker:
    | Awaited<ReturnType<typeof import("@/lib/audio/ffmpeg").openAudioWorker>>
    | undefined;
  const emit = (progress: PreparationProgress) =>
    notify(structuredClone(current), progress);
  async function checkpoint(stage: ProcessingJob["stage"]) {
    current.job = {
      ...current.job,
      stage,
      updatedAt: new Date().toISOString(),
      error: null,
    };
    await renewLease(current.job.id, token);
    await saveJob(current);
  }
  try {
    await checkpoint("analyzing");
    emit({
      stage: "analyzing",
      fraction: 0,
      message: "Verifica del file sul dispositivo",
    });
    const sha256 = await fingerprint(file, combined, (fraction) =>
      emit({
        stage: "analyzing",
        fraction,
        message: "Verifica del file sul dispositivo",
      }),
    );
    if (
      current.job.sourceFingerprint &&
      current.job.sourceFingerprint !== sha256
    )
      throw new Error(
        "Questo file non corrisponde alla lezione salvata. Seleziona la registrazione originale.",
      );
    const wav = await inspectWav(file);
    let duration: number;
    if (wav) duration = wav.duration;
    else {
      emit({
        stage: "analyzing",
        fraction: null,
        message: "Caricamento del motore audio, solo al primo utilizzo",
      });
      const { openAudioWorker } = await import("@/lib/audio/ffmpeg");
      worker = await openAudioWorker(file, combined);
      duration = worker.duration;
    }
    if (duration > AUDIO_LIMITS.maxDurationSeconds)
      throw new Error("La registrazione supera il limite di 120 minuti.");
    if (!Number.isFinite(duration) || duration <= 0)
      throw new Error("Impossibile determinare la durata dell’audio.");
    current.job.sourceFingerprint = sha256;
    current.manifest.source = {
      name: file.name,
      byteLength: file.size,
      durationSeconds: duration,
      sha256,
      mimeType: file.type,
    };
    const storage = await navigator.storage
      ?.estimate?.()
      .catch(() => undefined);
    // Remux keeps source size; normalization can reach 32 KB/s. Reserve headroom.
    const cachedBytes = current.manifest.chunks
      .filter((chunk) => current.preparedChunkIds.includes(chunk.id))
      .reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const needed =
      Math.max(0, (wav ? file.size : worker!.estimatedBytes) - cachedBytes) +
      8_000_000;
    if (storage?.quota && storage.quota - (storage.usage ?? 0) < needed)
      throw new Error(
        "Spazio sul dispositivo insufficiente. Elimina una lezione salvata o libera spazio e riprova.",
      );
    await navigator.storage?.persist?.().catch(() => false);
    await checkpoint("preparing");
    let start = 0,
      index = 0;
    while (start < duration) {
      abortIfNeeded(combined);
      if (index > 1_500)
        throw new Error(
          "Il file richiede troppi segmenti. Verifica il formato della registrazione.",
        );
      const existing = current.manifest.chunks[index];
      const cached = existing
        ? await getChunk(current.job.id, index)
        : undefined;
      let metadata: AudioChunk;
      if (
        existing &&
        cached &&
        cached.metadata.sha256 === existing.sha256 &&
        cached.blob.size === existing.byteLength &&
        (await fingerprint(cached.blob, combined)) === existing.sha256
      ) {
        metadata = existing;
        if (!current.preparedChunkIds.includes(metadata.id))
          current.preparedChunkIds.push(metadata.id);
      } else {
        emit({
          stage: "preparing",
          fraction: start / duration,
          message: `Preparazione del segmento ${index + 1}`,
        });
        const part = wav
          ? sliceWav(file, wav, start)
          : await worker!.chunk(start);
        if (
          part.blob.size > AUDIO_LIMITS.maxChunkBytes ||
          part.endSeconds <= start
        )
          throw new Error("Il segmento generato non rispetta i limiti.");
        const hash = await fingerprint(part.blob, combined);
        metadata = {
          id: `${current.job.id}:${index}`,
          index,
          startSeconds: part.startSeconds,
          endSeconds: part.endSeconds,
          overlapSeconds: index
            ? Math.max(
                0,
                current.manifest.chunks[index - 1].endSeconds -
                  part.startSeconds,
              )
            : 0,
          byteLength: part.blob.size,
          sha256: hash,
          mimeType: part.blob.type,
          codec: part.codec,
          container: part.container,
        };
        // If a missing chunk is regenerated with different boundaries, invalidate
        // its successors; their stored blobs cannot silently define a new timeline.
        current.manifest.chunks = [
          ...current.manifest.chunks.slice(0, index),
          metadata,
        ];
        current.preparedChunkIds = current.manifest.chunks.map(
          (entry) => entry.id,
        );
        current.job.updatedAt = new Date().toISOString();
        abortIfNeeded(combined);
        await savePreparedChunk(current, metadata, part.blob, token);
      }
      emit({
        stage: "preparing",
        fraction: metadata.endSeconds / duration,
        message: `${index + 1} segmenti preparati e salvati`,
      });
      const next = nextChunkStart(
        metadata.startSeconds,
        metadata.endSeconds,
        duration,
      );
      if (next === null) break;
      start = next;
      index++;
    }
    await checkpoint("ready");
    return current;
  } catch (error) {
    current.job = {
      ...current.job,
      stage: combined.aborted
        ? combined.reason === "cancelled"
          ? "cancelled"
          : "paused"
        : "failed",
      updatedAt: new Date().toISOString(),
      error: combined.aborted
        ? null
        : {
            code: "PREPARATION_FAILED",
            message:
              error instanceof DOMException &&
              error.name === "QuotaExceededError"
                ? "Spazio esaurito: libera spazio e riprendi la preparazione."
                : error instanceof Error
                  ? error.message
                  : "Preparazione interrotta. Riprova.",
            recoverable: true,
            retryAt: null,
          },
    };
    // A stale tab must not overwrite a newer owner's checkpoint.
    try {
      await renewLease(current.job.id, token);
      await saveJob(current);
    } catch {}
    if (!combined.aborted) throw new Error(current.job.error!.message);
    return current;
  } finally {
    clearInterval(timer);
    signal.removeEventListener("abort", relayAbort);
    worker?.close();
    await releaseLease(current.job.id, token).catch(() => {});
  }
}
