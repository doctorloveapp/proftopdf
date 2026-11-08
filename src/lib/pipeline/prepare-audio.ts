import { AUDIO_LIMITS } from "@/lib/shared/constants";
import type {
  AudioChunk,
  AudioSourcePart,
  ProcessingJob,
} from "@/lib/shared/types";
import { inspectWav, sliceWav, nextChunkStart } from "@/lib/audio/wav";
import { fingerprint, abortIfNeeded } from "@/lib/audio/fingerprint";
import { openMp3 } from "@/lib/audio/mp3";
import {
  timelineFingerprint,
  validateAudioSelection,
  virtualTimeline,
} from "@/lib/audio/timeline";
import { createAudioLog, type AudioLog } from "@/lib/audio/diagnostics";
import { audioFailure, AudioProcessingError } from "@/lib/audio/errors";
import { audioRepairFrom, beginAudioRepair } from "@/lib/audio/recovery";
import {
  acquireStoredJob,
  renewLease,
  releaseLease,
  savePreparedChunk,
  prunePreparedChunks,
  saveJobWithLease,
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
  stage:
    | "analyzing"
    | "preparing"
    | "transcribing"
    | "generating-notes"
    | "waiting-quota"
    | "completed";
  fraction: number | null;
  message: string;
}

/** Files are already in the user's chosen order. Never sort during resume. */
export async function prepareAudio(
  input: File | readonly File[],
  local: LocalJob,
  signal: AbortSignal,
  notify: (local: LocalJob, progress: PreparationProgress) => void,
  log: AudioLog = createAudioLog(local.job.id),
  forcePcm = false,
) {
  const files = Array.isArray(input) ? input : [input as File];
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  log("preparation.start", {
    bytes: totalBytes,
    parts: files.length,
    savedChunks: local.preparedChunkIds.length,
    online: navigator.onLine ?? false,
  });
  let token: string, current: LocalJob;
  try {
    validateAudioSelection(files);
    files.forEach(validateFile);
    const stored = await acquireStoredJob(local.job.id);
    token = stored.token;
    current = structuredClone(stored.local);
  } catch (error) {
    log("preparation.rejected", { code: "AUDIO_FILE_OR_LEASE" }, "error");
    throw error;
  }
  log("lease.acquired");
  const repairFrom =
    audioRepairFrom(current) ??
    (forcePcm ? (current.processing?.failedChunkIndex ?? 0) : undefined);
  // Any repair uses bounded PCM, but already verified prefix chunks stay intact.
  forcePcm ||= repairFrom !== undefined;
  if (repairFrom !== undefined && !current.audioRepair)
    current.audioRepairRequestedFrom = repairFrom;
  let phase = "fingerprint",
    activePart = 0;
  const aborter = new AbortController();
  const timer = setInterval(() => {
    renewLease(local.job.id, token).catch(() => {
      log("lease.lost", {}, "error");
      aborter.abort("lease-lost");
    });
  }, 5_000);
  const combined = aborter.signal;
  const relayAbort = () => aborter.abort(signal.reason);
  if (signal.aborted) relayAbort();
  else signal.addEventListener("abort", relayAbort, { once: true });
  let worker:
    | Awaited<ReturnType<typeof import("@/lib/audio/ffmpeg").openAudioWorker>>
    | Awaited<ReturnType<typeof openMp3>>
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
    await saveJobWithLease(current, token);
    log("checkpoint.saved", { stage, chunks: current.preparedChunkIds.length });
  }
  async function open(file: File) {
    abortIfNeeded(combined);
    // Unaffected earlier recordings must keep the same parser/duration policy.
    // Switching an earlier MP3 parser during a later-part repair can shift all
    // subsequent offsets because of codec padding / gapless metadata.
    const normalizePart =
      forcePcm && activePart >= (current.audioRepair?.sourcePartIndex ?? 0);
    const wav = await inspectWav(file);
    if (wav) {
      log("format.selected", {
        engine: "wav-js",
        part: activePart,
        durationSeconds: wav.duration,
      });
      return { wav, duration: wav.duration, estimatedBytes: file.size };
    }
    if (
      !normalizePart &&
      (/\.mp3$/i.test(file.name) || file.type === "audio/mpeg")
    ) {
      phase = "mp3-scan";
      log("format.selected", { engine: "mp3-js", part: activePart });
      worker = await openMp3(
        file,
        combined,
        (fraction) =>
          emit({
            stage: "analyzing",
            fraction: (activePart + fraction) / files.length,
            message: `Lettura dei frame MP3 · spezzone ${activePart + 1}/${files.length}`,
          }),
        log,
      );
    } else {
      phase = "worker";
      log("format.selected", { engine: "ffmpeg-wasm", part: activePart });
      emit({
        stage: "analyzing",
        fraction: null,
        message: `Caricamento del motore audio · spezzone ${activePart + 1}/${files.length}`,
      });
      const { openAudioWorker } = await import("@/lib/audio/ffmpeg");
      worker = await openAudioWorker(file, combined, log, normalizePart);
    }
    return {
      wav: null,
      duration: worker.duration,
      estimatedBytes: worker.estimatedBytes,
    };
  }
  try {
    await checkpoint("analyzing");
    const originals: Omit<AudioSourcePart, "index" | "startSeconds">[] = [];
    // Confirm EVERY original before invalidating derived data. Hash bounded
    // slices, never concatenate recordings or decode the full lecture.
    for (const [index, file] of files.entries()) {
      activePart = index;
      phase = "fingerprint";
      log("fingerprint.start", { part: index });
      const sha256 = await fingerprint(file, combined, (fraction) =>
        emit({
          stage: "analyzing",
          fraction: (index + fraction) / files.length,
          message: `Verifica originale ${index + 1}/${files.length}`,
        }),
      );
      originals.push({
        name: file.name,
        byteLength: file.size,
        mimeType: file.type,
        sha256,
        durationSeconds: 0,
        lastModified: file.lastModified,
      });
      log("fingerprint.complete", { part: index });
    }
    const sha256 = timelineFingerprint(originals);
    if (
      current.job.sourceFingerprint &&
      current.job.sourceFingerprint !== sha256
    )
      throw new AudioProcessingError(
        "AUDIO_SOURCE_MISMATCH",
        "fingerprint",
        "La sequenza dei file non corrisponde alla lezione salvata. Seleziona tutti gli originali nello stesso ordine.",
      );
    if (repairFrom !== undefined) {
      beginAudioRepair(current, repairFrom);
      await saveJobWithLease(current, token);
      log("format.normalize-requested", {
        output: "pcm_s16le",
        fromIndex: repairFrom,
        generation: current.audioRepair!.generation,
        retainedTranscripts: Object.keys(current.processing?.transcripts ?? {})
          .length,
      });
    }
    // Preflight one engine at a time. Know total duration/storage before saving
    // chunks: an interrupted first part must never look like a complete lesson.
    let estimatedBytes = 0;
    let singleEngine: Awaited<ReturnType<typeof open>> | undefined;
    for (const [index, file] of files.entries()) {
      activePart = index;
      phase = "format";
      const engine = await open(file);
      originals[index].durationSeconds = engine.duration;
      estimatedBytes += engine.estimatedBytes;
      if (files.length === 1) singleEngine = engine;
      else {
        worker?.close();
        worker = undefined;
      }
    }
    const sources = virtualTimeline(originals);
    const duration = sources.reduce(
      (sum, source) => sum + source.durationSeconds,
      0,
    );
    current.job.sourceFingerprint = sha256;
    current.manifest.source = {
      name:
        files.length === 1 ? files[0].name : `${files.length} registrazioni`,
      byteLength: totalBytes,
      durationSeconds: duration,
      sha256,
      mimeType: files.length === 1 ? files[0].type : "audio/multiple",
    };
    if (files.length > 1) current.manifest.sources = sources;
    const storage = await navigator.storage
      ?.estimate?.()
      .catch(() => undefined);
    const cachedBytes = current.manifest.chunks
      .filter((chunk) => current.preparedChunkIds.includes(chunk.id))
      .reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const needed = Math.max(0, estimatedBytes - cachedBytes) + 8_000_000;
    log("storage.estimate", {
      neededBytes: needed,
      quotaBytes: storage?.quota ?? null,
      usedBytes: storage?.usage ?? null,
    });
    if (storage?.quota && storage.quota - (storage.usage ?? 0) < needed)
      throw new Error(
        "Spazio sul dispositivo insufficiente. Elimina una lezione salvata o libera spazio e riprova.",
      );
    await navigator.storage?.persist?.().catch(() => false);
    await checkpoint("preparing");
    let index = 0;
    for (const source of sources) {
      activePart = source.index;
      const engine = singleEngine ?? (await open(files[source.index]));
      if (Math.abs(engine.duration - source.durationSeconds) > 0.01)
        throw new Error(
          "La durata dello spezzone è cambiata durante la preparazione.",
        );
      phase = "segments";
      let start = 0;
      log("timeline.part.start", {
        part: source.index,
        offsetSeconds: source.startSeconds,
        durationSeconds: source.durationSeconds,
      });
      while (start < source.durationSeconds) {
        abortIfNeeded(combined);
        if (index >= 1500)
          throw new Error(
            "La lezione richiede troppi segmenti. Verifica le registrazioni.",
          );
        const existing = current.manifest.chunks[index];
        const cached = existing
          ? await getChunk(current.job.id, index)
          : undefined;
        const confirmed =
          existing &&
          current.processing?.transcripts[existing.id]?.sha256 ===
            existing.sha256;
        let metadata: AudioChunk;
        if (
          existing &&
          (cached || confirmed) &&
          existing.startSeconds <= source.startSeconds + start + 0.00001 &&
          existing.startSeconds >= source.startSeconds + start - 5 &&
          existing.endSeconds > source.startSeconds + start &&
          (existing.sourcePartIndex ?? 0) === source.index &&
          existing.startSeconds >= source.startSeconds &&
          existing.endSeconds <=
            source.startSeconds + source.durationSeconds + 0.01 &&
          (confirmed ||
            (cached &&
              cached.metadata.sha256 === existing.sha256 &&
              cached.blob.size === existing.byteLength &&
              (await fingerprint(cached.blob, combined)) === existing.sha256))
        ) {
          metadata = existing;
          if (cached && !current.preparedChunkIds.includes(metadata.id))
            current.preparedChunkIds.push(metadata.id);
          log("chunk.restored", {
            index,
            generation: metadata.generation ?? 0,
            part: source.index,
            bytes: metadata.byteLength,
            startSeconds: metadata.startSeconds,
            endSeconds: metadata.endSeconds,
          });
        } else {
          emit({
            stage: "preparing",
            fraction: (source.startSeconds + start) / duration,
            message: `Spezzone ${source.index + 1}/${sources.length} · segmento ${index + 1}`,
          });
          log("chunk.start", {
            index,
            part: source.index,
            requestedStartSeconds: start,
          });
          const part = engine.wav
            ? sliceWav(files[source.index], engine.wav, start)
            : await worker!.chunk(start);
          if (
            part.blob.size > AUDIO_LIMITS.maxChunkBytes ||
            part.endSeconds <= start
          )
            throw new Error("Il segmento generato non rispetta i limiti.");
          const hash = await fingerprint(part.blob, combined);
          const globalStart = source.startSeconds + part.startSeconds;
          metadata = {
            id: `${current.job.id}:${index}`,
            index,
            ...(current.audioRepair
              ? { generation: current.audioRepair.generation }
              : existing?.generation !== undefined
                ? { generation: existing.generation }
                : {}),
            ...(sources.length > 1 ? { sourcePartIndex: source.index } : {}),
            startSeconds: globalStart,
            endSeconds: source.startSeconds + part.endSeconds,
            overlapSeconds:
              start > 0 && index
                ? Math.max(
                    0,
                    current.manifest.chunks[index - 1].endSeconds - globalStart,
                  )
                : 0,
            byteLength: part.blob.size,
            sha256: hash,
            mimeType: part.blob.type,
            codec: part.codec,
            container: part.container,
          };
          if (
            existing &&
            (existing.sha256 !== hash ||
              existing.startSeconds !== metadata.startSeconds ||
              existing.endSeconds !== metadata.endSeconds) &&
            current.processing
          ) {
            beginAudioRepair(current, index);
            metadata.generation = current.audioRepair!.generation;
            log("chunk.rebuilt", {
              index,
              generation: metadata.generation,
              retainedTranscripts: Object.keys(
                current.processing?.transcripts ?? {},
              ).length,
            });
          }
          const unchanged =
            existing &&
            existing.sha256 === metadata.sha256 &&
            existing.startSeconds === metadata.startSeconds &&
            existing.endSeconds === metadata.endSeconds;
          current.manifest.chunks = unchanged
            ? current.manifest.chunks.map((entry, n) =>
                n === index ? metadata : entry,
              )
            : [...current.manifest.chunks.slice(0, index), metadata];
          current.preparedChunkIds = unchanged
            ? [...new Set([...current.preparedChunkIds, metadata.id])]
            : current.manifest.chunks.map((entry) => entry.id);
          current.job.updatedAt = new Date().toISOString();
          abortIfNeeded(combined);
          await savePreparedChunk(current, metadata, part.blob, token);
          log("chunk.saved", {
            index,
            part: source.index,
            bytes: part.blob.size,
            startSeconds: metadata.startSeconds,
            endSeconds: metadata.endSeconds,
            overlapSeconds: metadata.overlapSeconds,
            generation: metadata.generation ?? 0,
          });
        }
        emit({
          stage: "preparing",
          fraction: metadata.endSeconds / duration,
          message: `${index + 1} segmenti preparati e salvati`,
        });
        index++;
        const next = nextChunkStart(
          metadata.startSeconds - source.startSeconds,
          metadata.endSeconds - source.startSeconds,
          source.durationSeconds,
        );
        if (next === null) break;
        start = next;
      }
      worker?.close();
      worker = undefined;
      log("timeline.part.complete", { part: source.index, chunks: index });
    }
    // Remove any obsolete tail from an older segmentation before declaring ready.
    current.manifest.chunks = current.manifest.chunks.slice(0, index);
    current.preparedChunkIds = current.preparedChunkIds.filter((id) =>
      current.manifest.chunks.some((c) => c.id === id),
    );
    delete current.audioRepair;
    delete current.audioRepairRequestedFrom;
    await prunePreparedChunks(current, token);
    await checkpoint("ready");
    log("preparation.complete", {
      chunks: current.manifest.chunks.length,
      parts: files.length,
      durationSeconds: duration,
    });
    return current;
  } catch (error) {
    const failure = audioFailure(error, phase);
    if (combined.aborted)
      log("preparation.paused", {
        reason:
          typeof combined.reason === "string" ? combined.reason : "interrupted",
        phase,
        part: activePart,
      });
    else
      log(
        "preparation.failed",
        {
          code: failure.code,
          phase: failure.phase,
          part: activePart,
          ...failure.details,
        },
        "error",
      );
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
            code: failure.code,
            message: failure.message,
            recoverable: true,
            retryAt: null,
          },
    };
    try {
      await saveJobWithLease(current, token);
    } catch {}
    if (!combined.aborted) throw failure;
    return current;
  } finally {
    clearInterval(timer);
    signal.removeEventListener("abort", relayAbort);
    worker?.close();
    await releaseLease(current.job.id, token).catch(() => {});
  }
}
