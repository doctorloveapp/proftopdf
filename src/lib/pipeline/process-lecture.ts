import { api, ClientApiError } from "@/lib/client/api";
import { fingerprint, abortIfNeeded } from "@/lib/audio/fingerprint";
import { createAudioLog } from "@/lib/audio/diagnostics";
import {
  acquireStoredJob,
  renewLease,
  releaseLease,
  saveJobWithLease,
  getChunk,
  type LocalJob,
} from "@/lib/storage/jobs";
import {
  emptyProcessing,
  MAX_ATTEMPTS,
  REPAIRABLE_NOTES_CODES,
  type ChunkTranscript,
  type NotesRequest,
  type NotesOutput,
  type OutlineOutput,
} from "@/lib/shared/processing";
import type { AudioChunk, ProcessingStage } from "@/lib/shared/types";
import { transcriptionProfile } from "@/lib/shared/lecture";
import type { PreparationProgress } from "./prepare-audio";
import { mergeTranscripts } from "@/lib/transcription/merge";
import {
  materializeSections,
  buildOutlineUnits,
  assembleDocument,
} from "@/lib/notes/assemble";

export interface ProcessingOptions {
  newAttempt?: boolean;
  accurate?: boolean;
  skipFailed?: boolean;
  recoverIndex?: number;
}
export interface ProcessingAdapter {
  transcribe(
    blob: Blob,
    chunk: AudioChunk,
    local: LocalJob,
    attempt: number,
    accurate: boolean,
    signal: AbortSignal,
  ): Promise<ChunkTranscript>;
  notes(
    input: NotesRequest,
    signal: AbortSignal,
  ): Promise<NotesOutput | OutlineOutput>;
  wait(until: string, signal: AbortSignal, tick: () => void): Promise<void>;
}
async function waitUntil(until: string, signal: AbortSignal, tick: () => void) {
  while (Date.now() < Date.parse(until)) {
    abortIfNeeded(signal);
    tick();
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        clearTimeout(timer);
        reject(new DOMException("Interrotto", "AbortError"));
      };
      const timer = setTimeout(
        () => {
          signal.removeEventListener("abort", abort);
          resolve();
        },
        Math.min(1000, Math.max(1, Date.parse(until) - Date.now())),
      );
      signal.addEventListener("abort", abort, { once: true });
    });
  }
  abortIfNeeded(signal);
}
export function browserAdapter(csrfToken: string): ProcessingAdapter {
  return {
    transcribe: (blob, chunk, local, attempt, accurate, signal) =>
      api("/api/transcribe", {
        method: "POST",
        signal,
        body: blob,
        headers: {
          "Content-Type": "application/octet-stream",
          "x-csrf-token": csrfToken,
          "x-job-id": local.job.id,
          "x-chunk-index": String(chunk.index),
          "x-chunk-start": String(chunk.startSeconds),
          "x-audio-sha256": chunk.sha256,
          "x-source-sha256": local.job.sourceFingerprint,
          "x-attempt": String(attempt),
          "x-accurate": String(accurate),
          "x-lecture-profile": transcriptionProfile(local.subject),
          "x-language-mode": local.manifest.language === "auto" ? "auto" : "it",
        },
      }),
    notes: (input, signal) =>
      api("/api/notes", {
        method: "POST",
        signal,
        body: JSON.stringify(input),
        headers: {
          "Content-Type": "application/json",
          "x-csrf-token": csrfToken,
        },
      }),
    wait: waitUntil,
  };
}
export async function processLecture(
  local: LocalJob,
  csrfToken: string,
  signal: AbortSignal,
  notify: (local: LocalJob, progress: PreparationProgress) => void,
  options: ProcessingOptions = {},
  adapter: ProcessingAdapter = browserAdapter(csrfToken),
  quotaChanged: () => void = () => {},
) {
  const stored = await acquireStoredJob(local.job.id),
    token = stored.token,
    current = structuredClone(stored.local);
  current.processing ??= emptyProcessing();
  const data = current.processing,
    log = createAudioLog(current.job.id);
  data.usageHistoryComplete ??= false;
  // v5 persisted a future retryAt before any local quota-denied operation
  // could start. Provider 429s incremented the attempt instead.
  if (
    current.job.retryAt &&
    ["waiting-quota", "paused"].includes(current.job.stage) &&
    data.failedUnitId &&
    (data.attempts[data.failedUnitId] ?? 0) === 0
  )
    data.quotaBlockedUnitId ??= data.failedUnitId;
  const aborter = new AbortController(),
    combined = aborter.signal;
  const relay = () => aborter.abort(signal.reason);
  if (signal.aborted) relay();
  else signal.addEventListener("abort", relay, { once: true });
  const heartbeat = setInterval(() => {
    renewLease(current.job.id, token).catch(() => aborter.abort("lease-lost"));
  }, 5000);
  let fraction = 0,
    message = "Ripresa del lavoro salvato";
  const emit = () =>
    notify(structuredClone(current), {
      stage: current.job.stage as PreparationProgress["stage"],
      fraction: current.job.stage === "waiting-quota" ? null : fraction,
      message,
    });
  async function save(stage: ProcessingStage = current.job.stage) {
    current.job.stage = stage;
    current.job.updatedAt = new Date().toISOString();
    await saveJobWithLease(current, token);
    emit();
  }
  function increment(key: string) {
    const attempt = (data.attempts[key] ?? 0) + 1;
    if (attempt >= MAX_ATTEMPTS)
      throw new ClientApiError(
        "Sono già stati usati i tre tentativi consentiti per questa unità. Esporta il log per verificare il problema.",
        422,
        null,
        "ATTEMPTS_EXHAUSTED",
      );
    data.attempts[key] = attempt;
  }
  async function waitForQuota(until: string, key: string) {
    current.job.retryAt = until;
    message = `Quota in attesa. Disponibile dal ${new Date(until).toLocaleString("it-IT")}`;
    await save("waiting-quota");
    const waitSeconds = Math.max(
      0,
      Math.ceil((Date.parse(until) - Date.now()) / 1000),
    );
    log("quota.wait", { unit: key, retryAt: until, waitSeconds });
    if (waitSeconds > 120) {
      message =
        "Attesa lunga per la quota: lavoro salvato, puoi chiudere l’app e riprendere più tardi.";
      log("quota.long-pause", { unit: key, retryAt: until, waitSeconds });
      aborter.abort("long-quota");
      abortIfNeeded(combined);
    }
    await adapter.wait(until, combined, emit);
    current.job.retryAt = null;
    message = "Quota disponibile, ripresa in corso";
  }
  async function recordUsage(
    key: string,
    attempt: number,
    usage?: import("@/lib/shared/types").NotesUsage,
  ) {
    if (!usage) return;
    data.notesUsage ??= {};
    data.notesUsage[`${key}:a${attempt}`] = usage;
    log("inference.usage", {
      unit: key,
      attempt,
      reservedTokens: usage.reservedTokens,
      confirmedTokens: usage.confirmedTokens ?? -1,
    });
    await save();
  }
  async function request<T>(
    key: string,
    stage: "transcribing" | "generating-notes",
    call: (attempt: number) => Promise<T>,
  ): Promise<T> {
    let recoveries = 0;
    while (true) {
      abortIfNeeded(combined);
      if (current.job.retryAt && Date.now() < Date.parse(current.job.retryAt)) {
        await waitForQuota(current.job.retryAt, key);
      }
      delete data.quotaBlockedUnitId;
      await save(stage);
      const attempt = data.attempts[key] ?? 0;
      log("inference.start", { unit: key, attempt, stage });
      try {
        const result = await call(attempt);
        if (stage === "generating-notes")
          await recordUsage(key, attempt, (result as NotesOutput).usage);
        quotaChanged();
        log("inference.complete", { unit: key, attempt, stage });
        return result;
      } catch (error) {
        if (combined.aborted) throw error;
        quotaChanged();
        const known = error instanceof ClientApiError ? error : null;
        if (stage === "generating-notes")
          await recordUsage(key, attempt, known?.diagnostics?.usage);
        log(
          "inference.failed",
          {
            unit: key,
            attempt,
            code: known?.code ?? "NETWORK",
            status: known?.status ?? 0,
            ...(known?.diagnostics
              ? { validation: JSON.stringify(known.diagnostics).slice(0, 1200) }
              : {}),
          },
          "error",
        );
        if (known?.status === 429 && known.retryAt) {
          if (known.code === "PROVIDER_RATE_LIMIT") increment(key);
          else if (
            ["QUOTA_EXHAUSTED", "RATE_LIMIT", "PROVIDER_COOLDOWN"].includes(
              known.code,
            )
          )
            data.quotaBlockedUnitId = key;
          await waitForQuota(known.retryAt, key);
          continue;
        }
        // Definitive invalid output is different from a lost/ambiguous reply.
        // Each repair gets its own persisted, quota-reserved attempt (max 3).
        if (
          stage === "generating-notes" &&
          key.startsWith("notes-") &&
          known?.code === "NOTES_TRUNCATED"
        )
          throw error;
        if (
          stage === "generating-notes" &&
          known &&
          REPAIRABLE_NOTES_CODES.has(known.code) &&
          (data.attempts[key] ?? 0) < MAX_ATTEMPTS - 1
        ) {
          increment(key);
          message = `Correzione dell’unità di appunti: tentativo ${(data.attempts[key] ?? 0) + 1} di ${MAX_ATTEMPTS}`;
          log("notes.repair", {
            unit: key,
            attempt: data.attempts[key],
            reason: known.code,
          });
          await save(stage);
          continue;
        }
        // Repeating the SAME operation only retrieves cache; it never starts a
        // second inference. Network/ambiguous responses get three retrievals.
        if ((!known || known.code === "RESULT_UNCERTAIN") && recoveries++ < 3) {
          const until = new Date(Date.now() + 15_000).toISOString();
          message = "Recupero della risposta già avviata";
          await adapter.wait(until, combined, emit);
          continue;
        }
        throw error;
      }
    }
  }
  try {
    if (!current.manifest.chunks.length || !current.job.sourceFingerprint)
      throw new Error("Prepara prima la registrazione.");
    const priorError = current.job.error;
    current.job.error = null;
    log("processing.start", {
      chunks: current.manifest.chunks.length,
      resume: Object.keys(data.transcripts).length > 0,
    });
    if (
      !options.newAttempt &&
      !options.accurate &&
      data.failedUnitId &&
      priorError &&
      REPAIRABLE_NOTES_CODES.has(priorError.code) &&
      (data.attempts[data.failedUnitId] ?? 0) < MAX_ATTEMPTS - 1
    ) {
      increment(data.failedUnitId);
      log("notes.repair", {
        unit: data.failedUnitId,
        attempt: data.attempts[data.failedUnitId],
        reason: priorError.code,
        resumed: true,
      });
      await save("generating-notes");
    }
    if (options.recoverIndex !== undefined) {
      const chunk = current.manifest.chunks[options.recoverIndex];
      if (!chunk) throw new Error("Segmento da recuperare non valido.");
      delete data.transcripts[chunk.id];
      data.failedChunkIndex = chunk.index;
      delete data.document;
      delete data.markdownDraft;
    }
    if (options.newAttempt || options.accurate) {
      const key =
        data.failedUnitId ??
        (data.failedChunkIndex !== undefined
          ? `stt-${data.failedChunkIndex}`
          : undefined);
      if (key) increment(key);
      if (
        options.accurate &&
        data.failedChunkIndex !== undefined &&
        !data.accurateChunks.includes(data.failedChunkIndex)
      )
        data.accurateChunks.push(data.failedChunkIndex);
      await save("paused");
    }
    if (options.skipFailed && data.failedChunkIndex !== undefined) {
      const chunk = current.manifest.chunks[data.failedChunkIndex];
      data.transcripts[chunk.id] = {
        sha256: chunk.sha256,
        model: "skipped-by-user",
        status: "missing",
        durationSeconds: chunk.endSeconds - chunk.startSeconds,
        segments: [],
      };
      log("transcription.skipped", { index: chunk.index });
      delete data.failedChunkIndex;
      await save("paused");
    }
    const chunks = current.manifest.chunks,
      total = current.manifest.source.durationSeconds;
    for (const chunk of chunks) {
      abortIfNeeded(combined);
      const result = data.transcripts[chunk.id];
      if (result?.sha256 === chunk.sha256) continue;
      delete data.failedUnitId;
      data.failedChunkIndex = chunk.index;
      message = `Trascrizione del segmento ${chunk.index + 1} di ${chunks.length}`;
      fraction = chunk.startSeconds / total;
      const cached = await getChunk(current.job.id, chunk.index);
      if (
        !cached ||
        cached.blob.size !== chunk.byteLength ||
        (await fingerprint(cached.blob, combined)) !== chunk.sha256
      )
        throw new ClientApiError(
          "Il segmento locale manca o è danneggiato. Riseleziona l’audio originale e riprendi la preparazione.",
          422,
          null,
          "LOCAL_AUDIO_MISSING",
        );
      const response = await request(
        `stt-${chunk.index}`,
        "transcribing",
        (attempt) =>
          adapter.transcribe(
            cached.blob,
            chunk,
            current,
            attempt,
            data.accurateChunks.includes(chunk.index),
            combined,
          ),
      );
      if (response.sha256 !== chunk.sha256)
        throw new Error("Risposta riferita a un segmento diverso.");
      data.transcripts[chunk.id] = response;
      delete data.failedChunkIndex;
      current.job.completedChunkIds = chunks
        .filter((c) => data.transcripts[c.id]?.sha256 === c.sha256)
        .map((c) => c.id);
      fraction = chunk.endSeconds / total;
      await save("transcribing");
      log("transcription.saved", {
        index: chunk.index,
        segments: response.segments.length,
      });
    }
    const segments = mergeTranscripts(current.manifest, data.transcripts);
    message = "Organizzazione del testo entro il budget gratuito";
    await save("generating-notes");
    const { planNotes, groupTextSources, splitFailedNotesUnit } =
      await import("@/lib/notes/batching");
    abortIfNeeded(combined);
    const context = {
      jobId: current.job.id,
      title: current.title,
      subject: current.subject,
      ...(current.manifest.language === "auto"
        ? { languagePolicy: "original" as const }
        : {}),
    };
    data.notesPlan = await planNotes(segments, data, context, combined);
    if (
      data.failedUnitId === data.quotaBlockedUnitId &&
      !data.notesPlan.units.some(
        (unit) => `notes-${unit.id}` === data.failedUnitId,
      )
    ) {
      delete data.failedUnitId;
      delete data.quotaBlockedUnitId;
    }
    const units = data.notesPlan.units;
    async function splitFailed(key: string, code: string) {
      if (
        !key.startsWith("notes-") ||
        (code !== "NOTES_TRUNCATED" &&
          (!["NOTES_COVERAGE", "NOTES_JSON"].includes(code) ||
            (data.attempts[key] ?? 0) < MAX_ATTEMPTS - 1))
      )
        return false;
      const result = splitFailedNotesUnit(
        data.notesPlan!,
        key.slice("notes-".length),
      );
      if (!result) return false;
      log("notes.split", {
        unit: key,
        sources: result.parent.sources.length,
        children: result.children.length,
        reason: code,
      });
      delete data.failedUnitId;
      message =
        "Recupero appunti: il gruppo non valido è stato diviso in due parti più semplici";
      // Persist before issuing either child, including the one-level split bound.
      await save("generating-notes");
      return true;
    }
    if (data.failedUnitId && priorError)
      await splitFailed(data.failedUnitId, priorError.code);
    log("notes.plan", {
      units: units.length,
      confirmed: units.filter((unit) => data.notes[unit.id]).length,
      policy: data.notesPlan.version,
    });
    await save("generating-notes");
    if (!units.length)
      throw new Error(
        "Non ci sono parti trascritte da trasformare in appunti.",
      );
    async function generate(
      unit: (typeof units)[number],
      mode: "notes" | "outline",
      index: number,
      length: number,
    ) {
      const destination = mode === "notes" ? data.notes : data.outlines;
      if (destination[unit.id]) return;
      data.failedUnitId = `${mode}-${unit.id}`;
      fraction = index / length;
      message =
        mode === "notes"
          ? `Creazione appunti: ${index + 1} di ${length}`
          : `Organizzazione capitoli: ${index + 1} di ${length}`;
      const response = await request(
        data.failedUnitId,
        "generating-notes",
        (attempt) =>
          adapter.notes(
            {
              jobId: current.job.id,
              unitId: unit.id,
              mode,
              attempt,
              title: current.title,
              subject: current.subject,
              ...(current.manifest.language === "auto"
                ? { languagePolicy: "original" as const }
                : {}),
              sources: unit.sources,
            },
            combined,
          ),
      );
      if (mode === "notes") data.notes[unit.id] = response as NotesOutput;
      else data.outlines[unit.id] = response as OutlineOutput;
      delete data.failedUnitId;
      current.job.completedNotesUnitIds = [
        ...Object.keys(data.notes),
        ...Object.keys(data.outlines),
      ];
      await save("generating-notes");
      log("notes.saved", {
        unit: unit.id,
        mode,
        sources: unit.sources.length,
        uncertainSources: unit.sources.filter((source) => source.uncertain)
          .length,
        ...(mode === "notes"
          ? {
              uncertaintyWarnings: (response as NotesOutput).uncertainties
                .length,
            }
          : {}),
      });
    }
    for (let index = 0; index < units.length; index++) {
      try {
        await generate(units[index], "notes", index, units.length);
      } catch (error) {
        if (
          error instanceof ClientApiError &&
          (await splitFailed(`notes-${units[index].id}`, error.code))
        ) {
          index--;
          continue;
        }
        throw error;
      }
    }
    const outlineUnits = await groupTextSources(
      buildOutlineUnits(materializeSections(units, data.notes)).flatMap(
        (unit) => unit.sources,
      ),
      context,
      "outline",
      combined,
    );
    for (const [index, unit] of outlineUnits.entries())
      await generate(unit, "outline", index, outlineUnits.length);
    data.document = assembleDocument({
      jobId: current.job.id,
      title: current.title,
      subject: current.subject,
      segments,
      units,
      notes: data.notes,
      outlines: data.outlines,
      outlineUnits,
    });
    current.job.error = null;
    current.job.retryAt = null;
    fraction = 1;
    message = data.document.complete
      ? "La dispensa è pronta"
      : "Dispensa parziale pronta: contiene segmenti mancanti";
    await save("completed");
    log("processing.complete", {
      sections: data.document.sections.length,
      gaps: data.document.gaps.length,
      complete: data.document.complete,
    });
    return current;
  } catch (error) {
    current.job.stage = combined.aborted
      ? combined.reason === "cancelled"
        ? "cancelled"
        : "paused"
      : "failed";
    current.job.error = combined.aborted
      ? null
      : {
          code:
            error instanceof ClientApiError ? error.code : "PROCESSING_FAILED",
          message:
            error instanceof Error ? error.message : "Elaborazione interrotta.",
          recoverable: true,
          retryAt: error instanceof ClientApiError ? error.retryAt : null,
          ...(error instanceof ClientApiError && error.diagnostics
            ? { diagnostics: error.diagnostics }
            : {}),
        };
    current.job.updatedAt = new Date().toISOString();
    log(
      combined.aborted ? "processing.paused" : "processing.failed",
      { code: current.job.error?.code ?? "PAUSED", stage: current.job.stage },
      combined.aborted ? "info" : "error",
    );
    await saveJobWithLease(current, token).catch(() => {});
    emit();
    if (!combined.aborted) throw error;
    return current;
  } finally {
    clearInterval(heartbeat);
    signal.removeEventListener("abort", relay);
    await releaseLease(current.job.id, token).catch(() => {});
  }
}
