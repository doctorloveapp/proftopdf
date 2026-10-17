// Local synthetic text only. Estimates are not observed long-audio timings.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { planNotes, groupTextSources } from "../src/lib/notes/batching";
import { buildTextUnits } from "../src/lib/notes/assemble";
import {
  openAiNotesPayload,
  lunaCostMicros,
} from "../src/lib/notes/provider-payload";
import { buildNotesRequest } from "../src/lib/notes/prompt";
import { reserveTextTokens } from "../src/lib/notes/token-budget";
import {
  emptyProcessing,
  type NotesRequest,
} from "../src/lib/shared/processing";
const words =
  "La seconda legge della dinamica descrive il rapporto tra forza risultante massa e accelerazione. Consideriamo un corpo su un piano inclinato e scomponiamo il peso nelle direzioni parallela e perpendicolare. Il lavoro si calcola moltiplicando forza spostamento e coseno dell’angolo. La conservazione dell’energia richiede di distinguere sistema e ambiente. F = ma; E = mc²; ΔE = Q − W. L’attrito dissipa energia meccanica e il calore modifica l’energia interna. Verifichiamo le unità e le condizioni di validità dell’approssimazione.".split(
    /\s+/u,
  );
const context = {
  jobId: crypto.randomUUID(),
  title: "Fisica sintetica",
  subject: "Fisica",
  languagePolicy: "original" as const,
};
const scenarios = [];
for (const wpm of [80, 110, 140]) {
  const text = Array.from(
    { length: wpm * 70 },
    (_, i) => words[i % words.length],
  );
  const segments = Array.from({ length: 250 }, (_, i) => ({
    id: `s${i}`,
    chunkId: `c${Math.floor((i * 33) / 250)}`,
    startSeconds: (i * 4252.42) / 250,
    endSeconds: ((i + 1) * 4252.42) / 250,
    status: "confirmed" as const,
    text: text
      .slice(
        Math.floor((i * text.length) / 250),
        Math.floor(((i + 1) * text.length) / 250),
      )
      .join(" "),
  }));
  const data = emptyProcessing();
  data.notesBudgetProfile = "large";
  const plan = await planNotes(segments, data, context);
  assert.deepEqual(
    plan.units.flatMap((u) => u.sources),
    buildTextUnits(segments).flatMap((u) => u.sources),
  );
  const outlines = await groupTextSources(
    plan.units.map((u, i) => ({
      id: `section-${i}`,
      text: "Dinamica, lavoro ed energia",
      uncertain: false,
    })),
    context,
    "outline",
  );
  const inputs: NotesRequest[] = [
    ...plan.units.map((unit) => ({
      ...context,
      ...unit,
      unitId: unit.id,
      mode: "notes" as const,
      attempt: 2,
    })),
    ...outlines.map((unit) => ({
      ...context,
      ...unit,
      unitId: unit.id,
      mode: "outline" as const,
      attempt: 2,
    })),
  ];
  const reservations = inputs.map((input) => {
    const payload = openAiNotesPayload(input);
    const common = buildNotesRequest(input);
    const budget = reserveTextTokens(
      common.messages,
      common.response_format,
      payload.max_output_tokens,
    );
    return {
      tokens: budget.tokenUpperBound,
      micros: lunaCostMicros(
        Math.ceil(budget.inputTokens * 1.2) + 512,
        payload.max_output_tokens,
      ),
    };
  });
  scenarios.push({
    words: text.length,
    syntheticSpeechSegments: 250,
    sourceCount: plan.units.flatMap((u) => u.sources).length,
    nativeNoteRequests: plan.units.length,
    outlineRequests: outlines.length,
    maximumReservationTokens: reservations.reduce((n, r) => n + r.tokens, 0),
    maximumReservedCostUsd:
      reservations.reduce((n, r) => n + r.micros, 0) / 1e6,
    extrapolatedMinutesAt28_5SecondsPerNotesCall:
      Math.round(
        (230 + plan.units.length * 28.5 + outlines.length * 3.2 + 12) / 6,
      ) / 10,
    conservativeMinutesAt60SecondsPerNotesCall:
      Math.round(
        (230 + plan.units.length * 60 + outlines.length * 15 + 12) / 6,
      ) / 10,
    assumedQuotaPauseSeconds: 0,
  });
}
const report = {
  checkedAt: new Date().toISOString(),
  evidence:
    "local synthetic Italian text planning; timing extrapolated from a separate 30-source native OpenAI probe; not real 70-minute audio",
  timingAssumptions:
    "230s preparation+STT from earlier real log, 12s local PDF allowance. Native app budget/TPM sufficient, no retries, no manual/background pauses. 28.5s notes and 3.2s outline measured on synthetic route integration. Conservative case allows 60s notes, 15s outline. Reservations include full output/reasoning caps, not expected spend.",
  scenarios,
};
await mkdir("docs", { recursive: true });
await writeFile(
  "docs/llm-cascade-benchmark.json",
  JSON.stringify(report, null, 2) + "\n",
);
console.log(JSON.stringify(report, null, 2));
