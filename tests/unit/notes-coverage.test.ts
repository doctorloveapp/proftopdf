import assert from "node:assert/strict";
import { test } from "node:test";
import {
  validateNotesOutput,
  buildNotesRequest,
} from "../../src/lib/notes/request";
import {
  STT_UNCERTAINTY_NOTICE,
  emptyProcessing,
  type NotesRequest,
  type NotesOutput,
} from "../../src/lib/shared/processing";
import { RouteError } from "../../src/lib/server/http-core";
import { materializeSections } from "../../src/lib/notes/assemble";
import { planNotes, splitFailedNotesUnit } from "../../src/lib/notes/batching";
import { notesProviderError } from "../../src/lib/server/notes-provider-error";
const input: NotesRequest = {
  jobId: crypto.randomUUID(),
  unitId: "batch-3-example",
  mode: "notes",
  attempt: 0,
  title: "Fisica",
  subject: "Fisica",
  sources: Array.from({ length: 12 }, (_, index) => ({
    id: `s3-${index}p0`,
    text: `Fonte ${index}: F = ma, lavoro ed energia.`,
    uncertain: index % 2 === 0,
  })),
};
const valid = (): NotesOutput => ({
  sections: [
    {
      title: "Dinamica",
      paragraphs: ["La forza risultante produce accelerazione."],
      bullets: [],
      concepts: [],
      sourceIds: input.sources.map((s) => s.id),
    },
  ],
  glossary: [],
  uncertainties: [],
  coveredSourceIds: [],
});
test("Provider JSON-generation failures are recoverable notes errors without leaking rejected content or suggesting an audio conversion", () => {
  const failure = notesProviderError("notes", {
    status: 400,
    error: {
      error: {
        code: "json_validate_failed",
        failed_generation: "PRIVATE_MODEL_RESPONSE",
      },
    },
  })!;
  assert.equal(failure.code, "NOTES_JSON");
  assert(!JSON.stringify(failure).includes("PRIVATE_MODEL_RESPONSE"));
  const other = notesProviderError("notes", {
    status: 400,
    error: { code: "invalid_schema" },
  })!;
  assert.equal(other.code, "NOTES_PROVIDER_REJECTED");
  assert(!other.message.includes("WAV"));
  assert.equal(notesProviderError("stt", { status: 400 }), null);
  assert.equal(notesProviderError("notes", { status: 429 }), null);
});
test("Derived coverage and deterministic STT warnings repair bookkeeping without pretending omitted sources were used", () => {
  const output = validateNotesOutput(input, valid()) as NotesOutput;
  assert.deepEqual(
    output.coveredSourceIds,
    input.sources.map((s) => s.id),
  );
  assert.deepEqual(output.uncertainties, [
    {
      text: STT_UNCERTAINTY_NOTICE,
      sourceIds: input.sources.filter((s) => s.uncertain).map((s) => s.id),
    },
  ]);
  assert.deepEqual(
    validateNotesOutput(input, output),
    output,
    "Normalization must be idempotent",
  );
  const sections = materializeSections(
    [{ id: input.unitId, sources: input.sources }],
    { [input.unitId]: output },
  );
  assert(
    sections[0].blocks.some(
      (block) =>
        block.type === "uncertainty" && block.text === STT_UNCERTAINTY_NOTICE,
    ),
  );
  const omitted = valid();
  omitted.coveredSourceIds = input.sources.map((s) => s.id);
  omitted.sections[0].sourceIds.pop();
  assert.throws(
    () => validateNotesOutput(input, omitted),
    (error: unknown) =>
      error instanceof RouteError &&
      error.code === "NOTES_COVERAGE" &&
      error.diagnostics?.coverage?.missingSectionSourceCount === 1 &&
      error.diagnostics.issues.some((issue) => issue.path === "sources.11"),
  );
});
test("Coverage diagnostics distinguish missing, empty and unknown citations without revealing generated text/IDs", () => {
  const raw = valid();
  raw.sections[0].sourceIds = ["s3-0p0", "PRIVATE_GENERATED_ID"];
  raw.glossary = [
    { term: "PRIVATE_TERM", definition: "PRIVATE_CONTENT", sourceIds: [] },
  ];
  try {
    validateNotesOutput(input, raw);
    assert.fail("Expected failure");
  } catch (error) {
    const failure = error as RouteError,
      info = failure.diagnostics!;
    assert.equal(info.coverage?.sourceCount, 12);
    assert.equal(info.coverage?.unknownReferenceCount, 1);
    assert.equal(info.coverage?.emptyReferenceCount, 1);
    assert.equal(info.coverage?.missingSectionSourceCount, 11);
    assert.equal(info.issueCount, 13);
    assert(info.issues.length <= 6);
    assert(
      !JSON.stringify({ message: failure.message, diagnostics: info }).includes(
        "PRIVATE_",
      ),
    );
  }
});
test("Provider schema constrains academic citations and leaves derived coverage/STT metadata to the app", () => {
  const schema = buildNotesRequest(input).response_format.json_schema
    .schema as any;
  assert.deepEqual(
    schema.properties.sourceNotes.required,
    input.sources.map((s) => s.id),
  );
  assert.equal(schema.properties.sourceNotes.additionalProperties, false);
  assert.deepEqual(
    schema.properties.glossary.items.properties.sourceId.enum,
    input.sources.map((s) => s.id),
  );
  assert.equal(schema.properties.coveredSourceIds, undefined);
  assert.equal(schema.properties.uncertainties, undefined);
  const {
    coveredSourceIds: _coverage,
    uncertainties: _warnings,
    ...content
  } = valid();
  assert.equal(
    (validateNotesOutput(input, content) as NotesOutput).coveredSourceIds
      .length,
    input.sources.length,
  );
});
test("A failed batch can split once, keeps all sources in order and persists a bound against further splits", async () => {
  const context = {
    jobId: input.jobId,
    title: input.title,
    subject: input.subject,
  };
  const data = emptyProcessing();
  const plan = await planNotes(
    input.sources.map((s, i) => ({
      id: `s${i}`,
      chunkId: "c0",
      text: s.text,
      startSeconds: i,
      endSeconds: i + 1,
      status: "confirmed" as const,
    })),
    data,
    context,
  );
  const unit = plan.units[0],
    sources = unit.sources;
  const split = splitFailedNotesUnit(plan, unit.id)!;
  assert.equal(split.children.length, 2);
  assert.deepEqual(
    split.children.flatMap((child) => child.sources),
    sources,
  );
  const restored = structuredClone(plan);
  assert.equal(splitFailedNotesUnit(restored, split.children[0].id), null);
  assert.equal(splitFailedNotesUnit(restored, split.children[1].id), null);
});
test("Prompt-budget upgrades repack untouched work while preserving confirmed units and an ambiguous operation", async () => {
  const context = {
    jobId: input.jobId,
    title: input.title,
    subject: input.subject,
  };
  const segments = Array.from({ length: 24 }, (_, i) => ({
    id: `s${i}`,
    chunkId: "c0",
    text: `Tema ${i}: la conservazione dell’energia richiede di definire il sistema e le forze esterne. `.repeat(
      4,
    ),
    startSeconds: i,
    endSeconds: i + 1,
    status: "confirmed" as const,
  }));
  const data = emptyProcessing(),
    plan = await planNotes(segments, data, context);
  const sources = plan.units.flatMap((unit) => unit.sources);
  plan.units = [{ id: "old-large-batch", sources }];
  plan.splitDepths = { "old-large-batch": 1 };
  delete plan.budgetRevision;
  data.notesPlan = plan;
  const upgraded = await planNotes(segments, data, context);
  assert(upgraded.units.length > 1);
  assert(upgraded.units.every((unit) => upgraded.splitDepths?.[unit.id] === 1));
  assert.deepEqual(
    upgraded.units.flatMap((unit) => unit.sources),
    sources,
  );
  assert(
    upgraded.units.every(
      (unit) =>
        buildNotesRequest({
          ...context,
          mode: "notes",
          attempt: 2,
          unitId: unit.id,
          sources: unit.sources,
        }).tokenUpperBound <= 5500,
    ),
  );
  data.failedUnitId = "notes-old-large-batch";
  const ambiguous = await planNotes(segments, data, context);
  assert.equal(ambiguous.units[0].id, "old-large-batch");
  // A rejected local reservation never started upstream, so this unit may be
  // resized to the new schema budget; confirmed/ambiguous units may not.
  data.quotaBlockedUnitId = data.failedUnitId;
  const quotaBlocked = await planNotes(segments, data, context);
  assert(quotaBlocked.units.length > 1);
  assert(quotaBlocked.units.every((unit) => unit.id !== "old-large-batch"));
  assert.deepEqual(
    quotaBlocked.units.flatMap((unit) => unit.sources),
    sources,
  );
});
