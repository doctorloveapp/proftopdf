import type { AudioDetails } from "./errors";

export const AUDIO_REVISION = "audio-2026-10-16-v1";
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
export function createAudioLog(jobId: string): AudioLog {
  const started = performance.now();
  const attemptId = crypto.randomUUID();
  const report: DiagnosticReport = reports().find((r) => r.jobId === jobId) ?? {
    schema: "proftopdf/audio-log/v1",
    revision: AUDIO_REVISION,
    jobId,
    updatedAt: new Date().toISOString(),
    persistent: false,
    droppedEvents: 0,
    events: [],
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
export function exportAudioLog(jobId: string) {
  const report = reports().find((r) => r.jobId === jobId);
  if (!report)
    throw new Error(
      "Nessun log disponibile per questa lezione. Avvia o riprendi la preparazione per registrare la diagnostica.",
    );
  return JSON.stringify(
    { ...report, exportedAt: new Date().toISOString() },
    null,
    2,
  );
}
export function removeAudioLog(jobId: string) {
  memory = reports().filter((r) => r.jobId !== jobId);
  try {
    globalThis.localStorage.setItem(KEY, JSON.stringify(memory));
  } catch {}
}
