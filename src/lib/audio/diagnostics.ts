import type { AudioDetails } from "./errors";
import {
  emptyTiming,
  recoverTiming,
  recordTiming,
  timingSummary,
  timingFromSummary,
  type TimingState,
  type TimingSummary,
} from "./timing";

export const AUDIO_REVISION = "llm-cascade-2026-10-17-v7";
const KEY = "proftopdf:audio-diagnostics:v1";
const MAX_REPORTS = 5,
  MAX_EVENTS = 200;
export interface DiagnosticEvent {
  at: string;
  attemptId: string;
  elapsedMs: number;
  level: "info" | "error";
  event: string;
  details: AudioDetails;
}
interface DiagnosticReport {
  schema: "proftopdf/audio-log/v1";
  revision: string;
  jobId: string;
  updatedAt: string;
  persistent: boolean;
  environment: AudioDetails;
  events: DiagnosticEvent[];
  droppedEvents: number;
  timingState?: TimingState;
}
let memory: DiagnosticReport[] = [];
function reports(): DiagnosticReport[] {
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    if (raw && raw.length <= 1_000_000) {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        const stored = parsed.filter(
          (r) =>
            r?.schema === "proftopdf/audio-log/v1" && Array.isArray(r.events),
        );
        // If a write fails after a previously successful save, retain the newer
        // in-memory tail so the immediate download still contains the error.
        const merged = [...memory.filter((r) => !r.persistent), ...stored];
        return merged
          .filter((r, i) => merged.findIndex((v) => v.jobId === r.jobId) === i)
          .slice(0, MAX_REPORTS);
      }
    }
  } catch {}
  return memory;
}
function save(report: DiagnosticReport) {
  while (report.events.length > 1 && JSON.stringify(report).length > 96_000) {
    report.events.shift();
    report.droppedEvents++;
  }
  const all = [
    report,
    ...reports().filter((r) => r.jobId !== report.jobId),
  ].slice(0, MAX_REPORTS);
  memory = all;
  try {
    report.persistent = true;
    globalThis.localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    report.persistent = false;
  }
}
export type AudioLog = (
  event: string,
  details?: AudioDetails,
  level?: "info" | "error",
) => void;
export function createAudioLog(
  jobId: string,
  priorTiming?: TimingSummary,
): AudioLog {
  const started = performance.now();
  const attemptId = crypto.randomUUID();
  let report: DiagnosticReport = reports().find((r) => r.jobId === jobId) ?? {
    schema: "proftopdf/audio-log/v1",
    revision: AUDIO_REVISION,
    jobId,
    updatedAt: new Date().toISOString(),
    persistent: false,
    droppedEvents: 0,
    events: [],
    timingState: priorTiming ? timingFromSummary(priorTiming) : emptyTiming(),
    environment: {
      userAgent:
        typeof navigator === "undefined"
          ? "unavailable"
          : navigator.userAgent.slice(0, 300),
      language:
        typeof navigator === "undefined" ? "unavailable" : navigator.language,
      cores:
        typeof navigator === "undefined" ? 0 : navigator.hardwareConcurrency,
      wasm: typeof WebAssembly !== "undefined",
      secureContext: globalThis.isSecureContext ?? false,
    },
  };
  report.revision = AUDIO_REVISION;
  return (event, details = {}, level = "info") => {
    // Another logger for this job may have written since this callback was
    // created (for example the PDF logger after a processing attempt).
    report = reports().find((r) => r.jobId === jobId) ?? report;
    report.revision = AUDIO_REVISION;
    report.timingState ??= recoverTiming(report.events, report.droppedEvents);
    // Callers supply technical data only: never file names, metadata, audio,
    // fingerprints, passwords, tokens, cookie values, or HTTP bodies.
    const bounded = Object.fromEntries(
      Object.entries(details)
        .slice(0, 20)
        .map(([k, v]) => [k, typeof v === "string" ? v.slice(0, 1200) : v]),
    );
    const entry: DiagnosticEvent = {
      at: new Date().toISOString(),
      attemptId,
      elapsedMs: Math.round(performance.now() - started),
      level,
      event,
      details: bounded,
    };
    report.updatedAt = entry.at;
    recordTiming(report.timingState, entry);
    report.events.push(entry);
    if (report.events.length > MAX_EVENTS) {
      report.events.shift();
      report.droppedEvents++;
    }
    save(report);
    (level === "error" ? console.error : console.info)("[ProfToPdf audio]", {
      revision: AUDIO_REVISION,
      jobId,
      ...entry,
    });
  };
}
export function summarizeNotesUsage(
  ledger: Record<string, import("@/lib/shared/types").NotesUsage> = {},
  historyComplete = false,
) {
  const values = Object.values(ledger).flatMap((value) =>
    value.legs?.length ? value.legs : [value],
  );
  const tagged = values.filter((value) => value.provider);
  return {
    trackedOperations: Object.keys(ledger).length,
    historyComplete,
    confirmedTokens: values.reduce(
      (sum, value) => sum + (value.confirmedTokens ?? 0),
      0,
    ),
    reservedUnverifiedTokens: values.reduce(
      (sum, value) =>
        sum + (value.confirmedTokens === null ? value.reservedTokens : 0),
      0,
    ),
    ...(tagged.length
      ? {
          confirmedCostUsd:
            tagged.reduce((sum, value) => sum + (value.costMicroUsd ?? 0), 0) /
            1e6,
          costHistoryComplete:
            historyComplete &&
            tagged.every(
              (value) =>
                value.costMicroUsd !== null && value.costMicroUsd !== undefined,
            ),
          providers: ["openai", "openrouter", "groq"].map((provider) => ({
            provider,
            operations: tagged.filter((value) => value.provider === provider)
              .length,
            confirmedTokens: tagged
              .filter((value) => value.provider === provider)
              .reduce((sum, value) => sum + (value.confirmedTokens ?? 0), 0),
            costUsd:
              tagged
                .filter((value) => value.provider === provider)
                .reduce((sum, value) => sum + (value.costMicroUsd ?? 0), 0) /
              1e6,
          })),
        }
      : {}),
  };
}
export function exportAudioLog(
  jobId: string,
  ledger?: Record<string, import("@/lib/shared/types").NotesUsage>,
  historyComplete = false,
) {
  const report = reports().find((r) => r.jobId === jobId);
  if (!report)
    throw new Error(
      "Nessun log disponibile per questa lezione. Avvia o riprendi la preparazione per registrare la diagnostica.",
    );
  const { timingState: state, ...publicReport } = report;
  return JSON.stringify(
    {
      ...publicReport,
      exportedAt: new Date().toISOString(),
      aiUsageSummary: summarizeNotesUsage(ledger, historyComplete),
      timingSummary: timingSummary(
        state ?? recoverTiming(report.events, report.droppedEvents),
      ),
    },
    null,
    2,
  );
}
export function readAudioTiming(jobId: string) {
  const report = reports().find((r) => r.jobId === jobId);
  return report
    ? timingSummary(
        report.timingState ??
          recoverTiming(report.events, report.droppedEvents),
      )
    : null;
}
export function hasGeneratedPdf(jobId: string) {
  const report = reports().find((r) => r.jobId === jobId);
  return Boolean(
    report &&
    (report.timingState?.phases.pdf.completed ||
      report.events.some((event) => event.event === "pdf.complete")),
  );
}
export function removeAudioLog(jobId: string) {
  memory = reports().filter((r) => r.jobId !== jobId);
  try {
    globalThis.localStorage.setItem(KEY, JSON.stringify(memory));
  } catch {}
}
