"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  prepareAudio,
  type PreparationProgress,
} from "@/lib/pipeline/prepare-audio";
import {
  listJobs,
  reconcileJob,
  saveJob,
  type LocalJob,
} from "@/lib/storage/jobs";
import { createAudioLog } from "@/lib/audio/diagnostics";
import { audioFailure } from "@/lib/audio/errors";
import {
  processLecture,
  type ProcessingOptions,
} from "@/lib/pipeline/process-lecture";

export function useAudioJob() {
  const [jobs, setJobs] = useState<LocalJob[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [progress, setProgress] = useState<PreparationProgress | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [quotaRevision, setQuotaRevision] = useState(0);
  const controller = useRef<AbortController | null>(null);
  const active = useRef(false),
    mounted = useRef(true);
  const completion = useRef<{
    promise: Promise<void>;
    resolve: () => void;
  } | null>(null);
  const refreshVersion = useRef(0);
  const upsert = useCallback((local: LocalJob) => {
    if (mounted.current)
      setJobs((old) => [
        local,
        ...old.filter((entry) => entry.job.id !== local.job.id),
      ]);
  }, []);
  const refresh = useCallback(async () => {
    const version = ++refreshVersion.current;
    const restored = await Promise.all((await listJobs()).map(reconcileJob));
    if (mounted.current && refreshVersion.current === version) {
      setJobs(restored);
      setSelectedId((id) =>
        restored.some((entry) => entry.job.id === id) ? id : null,
      );
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    refresh().catch(() =>
      setError(
        "Archivio locale non disponibile. Verifica lo spazio e le impostazioni del browser.",
      ),
    );
    const hide = () => {
      if (document.hidden) controller.current?.abort("page-hidden");
    };
    const pageHide = () => controller.current?.abort("page-hide");
    document.addEventListener("visibilitychange", hide);
    window.addEventListener("pagehide", pageHide);
    return () => {
      mounted.current = false;
      controller.current?.abort("component-unmounted");
      document.removeEventListener("visibilitychange", hide);
      window.removeEventListener("pagehide", pageHide);
    };
  }, [refresh]);
  const start = useCallback(
    async (file: File, title: string, subject: string, existing?: LocalJob) => {
      if (active.current) return;
      active.current = true;
      let resolve!: () => void;
      completion.current = {
        promise: new Promise<void>((done) => {
          resolve = done;
        }),
        resolve: () => resolve(),
      };
      setBusy(true);
      setError("");
      const aborter = new AbortController();
      controller.current = aborter;
      const id = crypto.randomUUID(),
        now = new Date().toISOString();
      const local: LocalJob = existing ?? {
        title: (title.trim() || "Nuova lezione").slice(0, 200),
        subject: subject.trim(),
        pdfGenerationTracked: true,
        preparedChunkIds: [],
        manifest: {
          version: 1,
          jobId: id,
          language: "auto",
          source: {
            name: file.name,
            byteLength: file.size,
            durationSeconds: 0,
            sha256: "",
            mimeType: file.type,
          },
          chunks: [],
        },
        job: {
          version: 1,
          id,
          stage: "selected",
          createdAt: now,
          updatedAt: now,
          sourceFingerprint: "",
          completedChunkIds: [],
          completedNotesUnitIds: [],
          retryAt: null,
          error: null,
        },
      };
      setSelectedId(local.job.id);
      const log = createAudioLog(local.job.id);
      log("job.open", { resume: Boolean(existing) });
      try {
        if (!existing) await saveJob(local);
        upsert(local);
        const result = await prepareAudio(
          file,
          local,
          aborter.signal,
          (entry, value) => {
            upsert(entry);
            if (mounted.current) setProgress(value);
          },
          log,
          ["AUDIO_NORMALIZATION_REQUIRED", "MP3_FREE_FORMAT"].includes(
            existing?.job.error?.code ?? "",
          ),
        );
        upsert(result);
      } catch (error) {
        const failure = audioFailure(error, "job");
        log("job.failed", { code: failure.code, ...failure.details }, "error");
        if (mounted.current)
          setError(
            error instanceof Error ? error.message : "Preparazione interrotta.",
          );
        await refresh().catch(() => {});
      } finally {
        active.current = false;
        controller.current = null;
        if (mounted.current) {
          setBusy(false);
          setProgress(null);
        }
        completion.current?.resolve();
        completion.current = null;
      }
    },
    [refresh, upsert],
  );
  const process = useCallback(
    async (
      local: LocalJob,
      csrfToken: string,
      options: ProcessingOptions = {},
    ) => {
      if (active.current) return;
      active.current = true;
      let resolve!: () => void;
      completion.current = {
        promise: new Promise<void>((done) => {
          resolve = done;
        }),
        resolve: () => resolve(),
      };
      setBusy(true);
      setError("");
      const aborter = new AbortController();
      controller.current = aborter;
      try {
        const result = await processLecture(
          local,
          csrfToken,
          aborter.signal,
          (entry, value) => {
            upsert(entry);
            if (mounted.current) setProgress(value);
          },
          options,
          undefined,
          () => {
            if (mounted.current) setQuotaRevision((n) => n + 1);
          },
        );
        upsert(result);
      } catch (error) {
        if (mounted.current)
          setError(
            error instanceof Error ? error.message : "Elaborazione interrotta.",
          );
        await refresh().catch(() => {});
      } finally {
        active.current = false;
        controller.current = null;
        if (mounted.current) {
          setBusy(false);
          setProgress(null);
          setQuotaRevision((n) => n + 1);
        }
        completion.current?.resolve();
        completion.current = null;
      }
    },
    [upsert, refresh],
  );
  return {
    jobs,
    selectedId,
    setSelectedId,
    progress,
    busy,
    error,
    setError,
    start,
    process,
    quotaRevision,
    pause: () => controller.current?.abort("user-pause"),
    cancel: () => controller.current?.abort("cancelled"),
    stopAndWait: async () => {
      controller.current?.abort("deleted");
      await completion.current?.promise;
    },
    refresh,
  };
}
