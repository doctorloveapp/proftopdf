import assert from "node:assert/strict";
import { test } from "node:test";
import { buildTextUnits } from "../../src/lib/notes/assemble";
import {
  groupTextSources,
  planNotes,
  NOTES_BATCH_RESERVATION,
} from "../../src/lib/notes/batching";
import { buildNotesRequest } from "../../src/lib/notes/prompt";
import { countTextTokens } from "../../src/lib/notes/token-budget";
import {
  emptyProcessing,
  notesRequestSchema,
  utf8Bytes,
} from "../../src/lib/shared/processing";
import type { TranscriptSegment } from "../../src/lib/shared/types";
const context = {
  jobId: crypto.randomUUID(),
  title: "Dinamica",
  subject: "Fisica",
  languagePolicy: "original" as const,
};
const segments: TranscriptSegment[] = Array.from({ length: 33 }, (_, i) => ({
  id: `s${i}`,
  chunkId: `c${i}`,
  startSeconds: i * 128,
  endSeconds: (i + 1) * 128,
  status: "confirmed",
  text: `Lezione ${i}. La forza risultante produce accelerazione secondo F = ma. Il lavoro trasferisce energia al sistema; discutiamo le ipotesi e le unità di misura. `.repeat(
    9,
  ),
}));
test("Token-aware batches preserve source order/text, fit repair requests and substantially reduce calls", async () => {
  const legacy = buildTextUnits(segments),
    data = emptyProcessing();
  const plan = await planNotes(segments, data, context);
  assert.deepEqual(
    plan.units.flatMap((u) => u.sources),
    legacy.flatMap((u) => u.sources),
  );
  assert(
    plan.units.length < legacy.length / 2,
    `${plan.units.length} vs ${legacy.length}`,
  );
  for (const unit of plan.units) {
    const input = {
      ...context,
      unitId: unit.id,
      mode: "notes" as const,
      attempt: 2,
      sources: unit.sources,
    };
    assert(notesRequestSchema.safeParse(input).success);
    assert(utf8Bytes(JSON.stringify(input)) <= 14_000);
    assert(buildNotesRequest(input).tokenUpperBound <= NOTES_BATCH_RESERVATION);
  }
  data.notesPlan = plan;
  assert.equal(await planNotes(segments, data, context), plan);
  assert.notEqual(
    (
      await planNotes(
        [
          { ...segments[0], text: segments[0].text + " Nuova parte." },
          ...segments.slice(1),
        ],
        data,
        context,
      )
    ).sourceDigest,
    plan.sourceDigest,
  );
});
test("Upgrade retains confirmed legacy units and the failed third operation without discarding source text", async () => {
  const legacy = buildTextUnits(segments),
    data = emptyProcessing();
  data.notes[legacy[0].id] = data.notes[legacy[1].id] = {
    sections: [],
    glossary: [],
    uncertainties: [],
    coveredSourceIds: [],
  };
  data.failedUnitId = `notes-${legacy[2].id}`;
  const plan = await planNotes(segments, data, context);
  assert.deepEqual(plan.units.slice(0, 3), legacy.slice(0, 3));
  assert(plan.units[3].id.startsWith("batch-"));
  assert.deepEqual(
    plan.units.flatMap((u) => u.sources),
    legacy.flatMap((u) => u.sources),
  );
});
test("Batch planning honours aborts, Unicode, literal special-token strings and bounded outline inputs", async () => {
  assert(countTextTokens("<|endoftext|> α ἄνθρωπος 力 ΔE = Q − W") > 0);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () =>
      groupTextSources(
        [{ id: "s0", text: "a", uncertain: false }],
        context,
        "notes",
        controller.signal,
      ),
    { name: "AbortError" },
  );
  const sources = Array.from({ length: 75 }, (_, i) => ({
    id: `batch-${i}-s0`,
    text: "ἄνθρωπος — Energy and lavoro",
    uncertain: false,
  }));
  const units = await groupTextSources(sources, context, "outline");
  assert.deepEqual(
    units.flatMap((u) => u.sources),
    sources,
  );
  assert(units.every((u) => u.sources.length <= 30));
});
