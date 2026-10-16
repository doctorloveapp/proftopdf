import type { DiagnosticEvent } from "./diagnostics";

const phases = ["audio", "processing", "pdf"] as const;
type Phase = (typeof phases)[number];
interface PhaseTiming {
  elapsedMs: number;
  completed: boolean;
  active?: { attemptId: string; lastElapsedMs: number };
}
export interface TimingState {
  version: 1;
  partial: boolean;
  phases: Record<Phase, PhaseTiming>;
}
export interface TimingSummary {
  tempoTotaleSecondi: number;
  tempoTotaleFormattato: string;
  preparazioneAudioSecondi: number;
  trascrizioneAppuntiSecondi: number;
  generazionePdfSecondi: number;
  completo: boolean;
  inCorso: boolean;
}
export function emptyTiming(partial = false): TimingState {
  return {
    version: 1,
    partial,
    phases: Object.fromEntries(
      phases.map((phase) => [phase, { elapsedMs: 0, completed: false }]),
    ) as Record<Phase, PhaseTiming>,
  };
}
/** A PDF receipt keeps the totals even after the log's five-job retention. */
export function timingFromSummary(summary: TimingSummary): TimingState {
  const state = emptyTiming(!summary.completo);
  const values = [
    summary.preparazioneAudioSecondi,
    summary.trascrizioneAppuntiSecondi,
    summary.generazionePdfSecondi,
  ];
  for (const [index, phase] of phases.entries()) {
    state.phases[phase] = {
      elapsedMs: Math.max(0, values[index]) * 1000,
      completed: summary.completo,
    };
  }
  return state;
}
const starts: Record<string, Phase> = {
  "preparation.start": "audio",
  "processing.start": "processing",
  "pdf.start": "pdf",
};
const ends: Record<string, Phase> = {
  "preparation.complete": "audio",
  "preparation.paused": "audio",
  "preparation.failed": "audio",
  "preparation.rejected": "audio",
  "processing.complete": "processing",
  "processing.paused": "processing",
  "processing.failed": "processing",
  "pdf.complete": "pdf",
  "pdf.failed": "pdf",
  "pdf.cancelled": "pdf",
};
/** Persist counters separately from the bounded event tail. No wall-clock gaps
 * between attempts are charged, and monotonic elapsed times survive clock changes. */
export function recordTiming(
  state: TimingState,
  event: Pick<DiagnosticEvent, "event" | "attemptId" | "elapsedMs">,
) {
  if (!Number.isFinite(event.elapsedMs) || event.elapsedMs < 0) {
    state.partial = true;
    return;
  }
  for (const phase of phases) {
    const timing = state.phases[phase];
    if (timing.active?.attemptId === event.attemptId) {
      if (event.elapsedMs < timing.active.lastElapsedMs) state.partial = true;
      timing.elapsedMs += Math.max(
        0,
        event.elapsedMs - timing.active.lastElapsedMs,
      );
      timing.active.lastElapsedMs = event.elapsedMs;
    }
  }
  const start = Object.hasOwn(starts, event.event)
    ? starts[event.event]
    : undefined;
  const end = Object.hasOwn(ends, event.event) ? ends[event.event] : undefined;
  if (start) {
    const timing = state.phases[start];
    if (timing.active) state.partial = true; // previous attempt crashed without a terminal event
    timing.active = {
      attemptId: event.attemptId,
      lastElapsedMs: event.elapsedMs,
    };
  }
  if (end) {
    const timing = state.phases[end];
    if (timing.active?.attemptId !== event.attemptId) state.partial = true;
    else delete timing.active;
    if (event.event.endsWith(".complete")) timing.completed = true;
  }
}
export function recoverTiming(
  events: DiagnosticEvent[],
  droppedEvents = 0,
): TimingState {
  const state = emptyTiming(droppedEvents > 0);
  for (const event of events) recordTiming(state, event);
  return state;
}
export function formatTiming(seconds: number, ui = false) {
  const rounded = Math.max(0, Math.round(seconds));
  return ui
    ? `${Math.floor(rounded / 60)} min ${rounded % 60} s`
    : `${Math.floor(rounded / 60)}m ${rounded % 60}s`;
}
export function timingSummary(state: TimingState): TimingSummary {
  const seconds = (ms: number) => Math.round(ms / 100) / 10;
  const total = seconds(
    phases.reduce((sum, phase) => sum + state.phases[phase].elapsedMs, 0),
  );
  const inCorso = phases.some((phase) => Boolean(state.phases[phase].active));
  return {
    tempoTotaleSecondi: total,
    tempoTotaleFormattato: formatTiming(total),
    preparazioneAudioSecondi: seconds(state.phases.audio.elapsedMs),
    trascrizioneAppuntiSecondi: seconds(state.phases.processing.elapsedMs),
    generazionePdfSecondi: seconds(state.phases.pdf.elapsedMs),
    completo:
      !state.partial &&
      !inCorso &&
      phases.every((phase) => state.phases[phase].completed),
    inCorso,
  };
}
