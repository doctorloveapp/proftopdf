import assert from "node:assert/strict";
import { test } from "node:test";
import {
  emptyTiming,
  recordTiming,
  recoverTiming,
  timingSummary,
  timingFromSummary,
} from "../../src/lib/audio/timing";
import {
  createAudioLog,
  exportAudioLog,
  hasGeneratedPdf,
  readAudioTiming,
  removeAudioLog,
  type DiagnosticEvent,
} from "../../src/lib/audio/diagnostics";

function event(
  name: string,
  elapsedMs: number,
  attemptId = "first",
): DiagnosticEvent {
  return {
    at: "2026-10-17T10:00:00.000Z",
    event: name,
    elapsedMs,
    attemptId,
    level: "info",
    details: {},
  };
}
test("Timing sums actual phase durations, includes quota waits and excludes time between clicks", () => {
  const events = [
    event("preparation.start", 100),
    event("preparation.complete", 2600),
    event("processing.start", 20, "second"),
    event("inference.failed", 50000, "second"),
    event("quota.wait", 50010, "second"),
    event("processing.complete", 147120, "second"),
    event("pdf.start", 0, "third"),
    event("pdf.complete", 3500, "third"),
  ];
  // Date/time gaps and changes of the wall clock are irrelevant to elapsed time.
  events[2].at = "2026-10-18T13:00:00.000Z";
  events[6].at = "2026-10-19T09:00:00.000Z";
  assert.deepEqual(timingSummary(recoverTiming(events)), {
    tempoTotaleSecondi: 153.1,
    tempoTotaleFormattato: "2m 33s",
    preparazioneAudioSecondi: 2.5,
    trascrizioneAppuntiSecondi: 147.1,
    generazionePdfSecondi: 3.5,
    completo: true,
    inCorso: false,
  });
});

test("PDF receipt totals remain usable when regenerating after diagnostic history is evicted", () => {
  const prior = {
    tempoTotaleSecondi: 153.1,
    tempoTotaleFormattato: "2m 33s",
    preparazioneAudioSecondi: 2.5,
    trascrizioneAppuntiSecondi: 147.1,
    generazionePdfSecondi: 3.5,
    completo: true,
    inCorso: false,
  };
  const state = timingFromSummary(prior);
  recordTiming(state, event("pdf.start", 0, "regenerate"));
  recordTiming(state, event("pdf.complete", 2000, "regenerate"));
  const summary = timingSummary(state);
  assert.equal(summary.tempoTotaleSecondi, 155.1);
  assert.equal(summary.generazionePdfSecondi, 5.5);
  assert(summary.completo);
});
test("Pause/resume and failed attempts are cumulative without counting the paused interval", () => {
  const state = emptyTiming();
  for (const entry of [
    event("preparation.start", 0),
    event("preparation.paused", 10000),
    event("preparation.start", 1000, "resume"),
    event("preparation.complete", 3000, "resume"),
    event("processing.start", 0, "failed"),
    event("processing.failed", 2000, "failed"),
    event("processing.start", 0, "retry"),
    event("processing.complete", 3000, "retry"),
    event("pdf.start", 0, "pdf"),
    event("pdf.complete", 1000, "pdf"),
  ])
    recordTiming(state, entry);
  const summary = timingSummary(state);
  assert.equal(summary.tempoTotaleSecondi, 18);
  assert.equal(summary.preparazioneAudioSecondi, 12);
  assert.equal(summary.trascrizioneAppuntiSecondi, 5);
  assert(summary.completo);
  assert(!summary.inCorso);
});
test("Truncated legacy logs and attempts missing a terminal event are explicitly partial", () => {
  const state = recoverTiming([
    event("preparation.start", 0),
    event("progress", 1000),
    event("preparation.start", 0, "after-crash"),
    event("preparation.complete", 2000, "after-crash"),
  ]);
  assert.equal(timingSummary(state).preparazioneAudioSecondi, 3);
  assert(!timingSummary(state).completo);
  assert(
    !timingSummary(recoverTiming([event("pdf.complete", 3500)], 200)).completo,
  );
});
test("Persistent timing survives event eviction and independent loggers without overwriting their events", (t) => {
  t.mock.method(console, "info", () => {});
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    },
  });
  let clock = 0;
  t.mock.method(performance, "now", () => clock);
  const id = crypto.randomUUID();
  try {
    const audio = createAudioLog(id),
      processing = createAudioLog(id);
    audio("preparation.start");
    clock = 2500;
    audio("preparation.complete");
    clock = 20000;
    processing("processing.start");
    for (let i = 1; i <= 230; i++) {
      clock = 20000 + i * 500;
      processing("progress");
    }
    clock = 167100;
    processing("processing.complete");
    clock = 300000;
    const pdf = createAudioLog(id);
    pdf("pdf.start");
    clock += 3500;
    pdf("pdf.complete", { bytes: 1000 });
    const report = JSON.parse(exportAudioLog(id));
    assert.equal(report.events.length, 200);
    assert(report.droppedEvents > 0);
    assert.equal(report.timingSummary.tempoTotaleSecondi, 153.1);
    assert.equal(report.timingSummary.completo, true);
    assert.equal(readAudioTiming(id)?.tempoTotaleSecondi, 153.1);
    assert.equal(hasGeneratedPdf(id), true);
    assert(!("timingState" in report));
    // Successful PDF history also survives eviction of its completion event.
    for (let i = 0; i < 220; i++) pdf("progress");
    assert(hasGeneratedPdf(id));
    assert.equal(
      JSON.parse(exportAudioLog(id)).timingSummary.tempoTotaleSecondi,
      153.1,
    );
  } finally {
    removeAudioLog(id);
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});
