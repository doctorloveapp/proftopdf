import { test } from "node:test";
import assert from "node:assert/strict";
import { acceptNotesCompletion } from "../../src/lib/notes/completion";
import { buildNotesRequest } from "../../src/lib/notes/prompt";
import { RouteError } from "../../src/lib/server/http-core";
import { summarizeNotesUsage } from "../../src/lib/audio/diagnostics";
import type {
  NotesRequest,
  NotesOutput,
} from "../../src/lib/shared/processing";
const input: NotesRequest = {
  jobId: crypto.randomUUID(),
  unitId: "source-test",
  mode: "notes",
  attempt: 0,
  title: "Dinamica",
  subject: "Fisica",
  sources: [
    { id: "s0", text: "La forza è F = ma.", uncertain: false },
    { id: "s1", text: "Il lavoro trasferisce energia.", uncertain: true },
  ],
};
const raw = () => ({
  title: "Forza ed energia",
  sourceNotes: {
    s0: {
      paragraphs: ["La forza risultante è F = ma."],
      bullets: [],
      concepts: [],
    },
    s1: {
      paragraphs: [],
      bullets: ["Il lavoro trasferisce energia."],
      concepts: ["**Energia**"],
    },
  },
  glossary: [
    { term: "Forza", definition: "Grandezza vettoriale.", sourceId: "s0" },
  ],
});
test("Required source entries yield body references only after validating every entry; warnings remain deterministic", () => {
  const output = acceptNotesCompletion(
    input,
    "stop",
    JSON.stringify(raw()),
  ) as NotesOutput;
  assert.deepEqual(output.coveredSourceIds, ["s0", "s1"]);
  assert.deepEqual(output.sections[0].sourceIds, ["s0", "s1"]);
  assert.equal(
    output.sections[0].paragraphs[0],
    raw().sourceNotes.s0.paragraphs[0],
  );
  assert.equal(output.sections[0].bullets[0], raw().sourceNotes.s1.bullets[0]);
  assert.deepEqual(output.glossary[0].sourceIds, ["s0"]);
  assert.deepEqual(output.uncertainties[0].sourceIds, ["s1"]);
  assert(buildNotesRequest(input).maxOutput < 2400);
});
test("Missing, unknown and blank source entries never fake coverage or leak model text into diagnostics", () => {
  for (const mutate of [
    (value: any) => {
      delete value.sourceNotes.s1;
    },
    (value: any) => {
      value.sourceNotes.PRIVATE_AUDIO_TEXT = value.sourceNotes.s0;
    },
    (value: any) => {
      value.sourceNotes.s1 = { paragraphs: [" "], bullets: [], concepts: [] };
    },
    (value: any) => {
      value.glossary[0].sourceId = "PRIVATE_AUDIO_TEXT";
    },
  ]) {
    const value = raw();
    mutate(value);
    assert.throws(
      () => acceptNotesCompletion(input, "stop", JSON.stringify(value)),
      (error: unknown) => {
        assert(error instanceof RouteError);
        assert(
          !JSON.stringify(error.diagnostics).includes("PRIVATE_AUDIO_TEXT"),
        );
        return true;
      },
    );
  }
});
test("Usage summary counts unique persisted operations and explicitly marks incomplete legacy history", () => {
  const ledger = {
    "notes-a:a0": { reservedTokens: 5000, confirmedTokens: 1800 },
    "notes-a:a1": { reservedTokens: 5000, confirmedTokens: null },
  };
  ledger["notes-a:a0"] = { reservedTokens: 5000, confirmedTokens: 1800 };
  assert.deepEqual(summarizeNotesUsage(ledger, false), {
    trackedOperations: 2,
    historyComplete: false,
    confirmedTokens: 1800,
    reservedUnverifiedTokens: 5000,
  });
  assert.equal(summarizeNotesUsage(ledger, true).historyComplete, true);
});
