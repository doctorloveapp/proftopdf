// Local synthetic text only: no audio, provider, Redis or browser.
import { mkdir, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import assert from "node:assert/strict";
import { buildTextUnits } from "../src/lib/notes/assemble";
import { planNotes, groupTextSources } from "../src/lib/notes/batching";
import { buildNotesRequest } from "../src/lib/notes/prompt";
import { emptyProcessing, utf8Bytes } from "../src/lib/shared/processing";
const words =
  "La seconda legge della dinamica descrive il rapporto tra forza risultante massa e accelerazione. Consideriamo un corpo su un piano inclinato e scomponiamo il peso nelle direzioni parallela e perpendicolare. Il lavoro di una forza costante si calcola moltiplicando forza spostamento e coseno dell’angolo. La conservazione dell’energia richiede di distinguere il sistema dall’ambiente. F = ma; E = mc²; ΔE = Q − W. L’attrito dissipa energia meccanica e il calore modifica l’energia interna. Verifichiamo le unità di misura e discutiamo le condizioni di validità dell’approssimazione. "
    .trim()
    .split(/\s+/u);
const context = {
  jobId: crypto.randomUUID(),
  title: "Lezione sintetica di fisica",
  subject: "Fisica",
  languagePolicy: "original" as const,
};
const scenarios = [];
for (const wordsPerMinute of [80, 110, 140]) {
  const text = Array.from(
    { length: wordsPerMinute * 70 },
    (_, i) => words[i % words.length],
  ).join(" ");
  const tokens = text.split(" "),
    // The real log saved 250 speech segments across 33 audio chunks.
    segmentCount = 250;
  const segments = Array.from({ length: segmentCount }, (_, i) => ({
    id: `s${Math.floor((i * 33) / segmentCount)}-${i % 9}`,
    chunkId: `c${Math.floor((i * 33) / segmentCount)}`,
    startSeconds: (i * 4252.42) / segmentCount,
    endSeconds: ((i + 1) * 4252.42) / segmentCount,
    status: "confirmed" as const,
    text: tokens
      .slice(
        Math.floor((i * tokens.length) / segmentCount),
        Math.floor(((i + 1) * tokens.length) / segmentCount),
      )
      .join(" "),
  }));
  const legacy = buildTextUnits(segments),
    start = performance.now();
  const plan = await planNotes(segments, emptyProcessing(), context);
  const payloads = plan.units.map((unit) =>
    buildNotesRequest({
      ...context,
      mode: "notes",
      attempt: 2,
      unitId: unit.id,
      sources: unit.sources,
    }),
  );
  assert.deepEqual(
    plan.units.flatMap((unit) => unit.sources),
    legacy.flatMap((unit) => unit.sources),
  );
  assert(payloads.every((payload) => payload.tokenUpperBound <= 5500));
  // The source-map contract assembles exactly one section per batch.
  const titles = plan.units.flatMap((unit) =>
    Array.from({ length: 1 }, (_, i) => ({
      id: `${unit.id}-s${i}`,
      text: `Dinamica, lavoro ed energia: argomento ${i + 1}`,
      uncertain: false,
    })),
  );
  const outlines = await groupTextSources(titles, context, "outline");
  scenarios.push({
    wordsPerMinute,
    words: tokens.length,
    sourceBytes: utf8Bytes(text),
    syntheticSpeechSegments: segmentCount,
    legacyNoteRequests: legacy.length,
    newNoteRequests: plan.units.length,
    hypotheticalOutlineRequests: outlines.length,
    totalNotesReservation: payloads.reduce(
      (sum, p) => sum + p.tokenUpperBound,
      0,
    ),
    totalWithOutlineReservation:
      payloads.reduce((sum, p) => sum + p.tokenUpperBound, 0) +
      outlines.reduce(
        (sum, unit) =>
          sum +
          buildNotesRequest({
            ...context,
            mode: "outline",
            attempt: 2,
            unitId: unit.id,
            sources: unit.sources,
          }).tokenUpperBound,
        0,
      ),
    planningMilliseconds: Math.round(performance.now() - start),
    largestReservation: Math.max(...payloads.map((p) => p.tokenUpperBound)),
    oneRequestPerMinuteTotalMinutes:
      Math.round((230 / 60 + plan.units.length + outlines.length + 0.2) * 10) /
      10,
  });
}
const report = {
  checkedAt: new Date().toISOString(),
  evidence:
    "local synthetic Italian physics text, not a real audio/provider timing test",
  durationMinutes: 70,
  timingModel:
    "Synthetic text distributed across 250 speech segments, matching the real log's segment count. Observed preparation + STT rounded to 230 seconds; deliberately allow 60 seconds per notes/outline request; 12 seconds PDF. Empty initial quota; no errors or manual pause; exactly one section per source-map batch. Reservation totals include input safety margin and maximum completion, not just expected actual consumption.",
  scenarios,
};
await mkdir("docs", { recursive: true });
await writeFile(
  "docs/notes-batching-benchmark.json",
  JSON.stringify(report, null, 2) + "\n",
);
console.log(JSON.stringify(report, null, 2));
