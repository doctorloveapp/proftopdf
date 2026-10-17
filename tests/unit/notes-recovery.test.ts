import assert from "node:assert/strict";
import { test } from "node:test";
import {
  validateNotesOutput,
  buildNotesRequest,
} from "../../src/lib/notes/request";
import { acceptNotesCompletion } from "../../src/lib/notes/completion";
import {
  notesOutputSchema,
  type NotesRequest,
  type NotesOutput,
} from "../../src/lib/shared/processing";
import {
  performOperation,
  type OperationDependencies,
} from "../../src/lib/server/operation-core";
import { RouteError } from "../../src/lib/server/http-core";

const input = (attempt = 0): NotesRequest => ({
  jobId: crypto.randomUUID(),
  unitId: "unit-0",
  mode: "notes",
  attempt,
  title: "Fisica",
  subject: "Fisica",
  sources: [
    {
      id: "s0",
      text: "F = ma. La forza produce accelerazione; la massa è costante.",
      uncertain: false,
    },
  ],
});
const valid = (): NotesOutput => ({
  sections: [
    {
      title: "Dinamica",
      paragraphs: ["La forza produce accelerazione: F = ma."],
      concepts: [],
      bullets: [],
      sourceIds: ["s0"],
    },
  ],
  glossary: [],
  uncertainties: [],
  coveredSourceIds: ["s0"],
});

test("Provider-compatible notes exceeding the old hidden item limits preserve all substantive content", () => {
  const raw = valid();
  raw.sections = Array.from({ length: 6 }, (_, i) => ({
    ...raw.sections[0],
    title: `Sezione ${i + 1}`,
    paragraphs: Array.from({ length: 9 }, (_, j) => `Paragrafo ${j}: F = ma.`),
    bullets: Array.from({ length: 13 }, (_, j) => `Punto ${j}`),
    concepts: Array.from({ length: 9 }, (_, j) => `Concetto ${j}`),
  }));
  raw.glossary = Array.from({ length: 9 }, (_, i) => ({
    term: `Termine ${i}`,
    definition: "Definizione nelle fonti.",
    sourceIds: ["s0"],
  }));
  assert(notesOutputSchema.safeParse(raw).success);
  const normalized = validateNotesOutput(input(), raw) as NotesOutput;
  assert.deepEqual(normalized, raw);
  assert.equal(normalized.sections[5].paragraphs.length, 9);
  assert.equal(normalized.sections[5].bullets.length, 13);
  assert.equal(normalized.glossary.length, 9);
});
test("Blank placeholders and duplicate references are normalized without rewriting physics or discarding notes", () => {
  const raw = valid();
  raw.sections[0].paragraphs.push(
    "",
    "   ",
    "E = mc²; ΔE = Q - W. ἄνθρωπος; English stays English.",
  );
  raw.sections[0].bullets = ["", "La massa si misura in kg."];
  raw.sections[0].sourceIds = ["s0", "s0", " "];
  raw.glossary = [{ term: "", definition: "", sourceIds: [] }];
  const result = validateNotesOutput(input(), raw) as NotesOutput;
  assert.deepEqual(result.sections[0].paragraphs, [
    "La forza produce accelerazione: F = ma.",
    "E = mc²; ΔE = Q - W. ἄνθρωπος; English stays English.",
  ]);
  assert.deepEqual(result.sections[0].sourceIds, ["s0"]);
  assert.equal(result.glossary.length, 0);
});
test("Structural errors identify schema paths/types but never copy model text or unknown field names", () => {
  const raw = {
    ...valid(),
    sections: [
      {
        ...valid().sections[0],
        paragraphs: { private_transcript: "NEVER_LOG_THIS_CONTENT" },
        secret_field: "NEVER_LOG_THIS_SECRET",
      },
    ],
  };
  try {
    validateNotesOutput(input(), raw);
    assert.fail("Expected invalid structure");
  } catch (error) {
    const failure = error as RouteError;
    assert.equal(failure.code, "NOTES_INVALID");
    assert.equal(failure.diagnostics?.stage, "structure");
    assert(
      failure.diagnostics?.issues.some(
        (issue) =>
          issue.path === "sections.0.paragraphs" && issue.expected === "array",
      ),
    );
    assert(
      !JSON.stringify({
        message: failure.message,
        diagnostics: failure.diagnostics,
      }).includes("NEVER_LOG"),
    );
    assert(!JSON.stringify(failure.diagnostics).includes("secret_field"));
  }
});
test("Meaningful title/body/source checks remain mandatory and STT uncertainty is preserved even when the model omits it", () => {
  for (const raw of [
    { ...valid(), sections: [] },
    { ...valid(), sections: [{ ...valid().sections[0], title: " " }] },
    { ...valid(), sections: [{ ...valid().sections[0], paragraphs: [" "] }] },
    {
      ...valid(),
      glossary: [{ term: "Massa", definition: "Misura", sourceIds: [] }],
    },
  ])
    assert.throws(() => validateNotesOutput(input(), raw));
  const uncertain = validateNotesOutput(
    { ...input(), sources: [{ ...input().sources[0], uncertain: true }] },
    valid(),
  ) as NotesOutput;
  assert.equal(uncertain.uncertainties.length, 1);
  assert.deepEqual(uncertain.uncertainties[0].sourceIds, ["s0"]);
  assert.throws(
    () => acceptNotesCompletion(input(), "length", JSON.stringify(valid())),
    { code: "NOTES_TRUNCATED" },
  );
  assert.throws(() => acceptNotesCompletion(input(), "stop", "{invalid}"), {
    code: "NOTES_JSON",
  });
  assert.throws(
    () => acceptNotesCompletion(input(), "stop", " ".repeat(44_001)),
    { code: "NOTES_SIZE" },
  );
});
test("Thirteen valid outline groups are accepted without losing order or permitting empty chapters", () => {
  const request = {
    ...input(),
    mode: "outline" as const,
    sources: Array.from({ length: 13 }, (_, i) => ({
      id: `s${i}`,
      text: `Titolo ${i}`,
      uncertain: false,
    })),
  };
  const outline = {
    chapters: request.sources.map((source, i) => ({
      title: `Capitolo ${i}`,
      sectionIds: [source.id],
    })),
  };
  assert.deepEqual(validateNotesOutput(request, outline), outline);
  assert.throws(() =>
    validateNotesOutput(request, {
      chapters: [...outline.chapters, { title: "Vuoto", sectionIds: [] }],
    }),
  );
});
test("Repair prompts still fit the complete free-tier reservation budget for maximum Unicode metadata", () => {
  const payload = buildNotesRequest({
    ...input(2),
    title: "ω".repeat(200),
    subject: "Greco",
    sources: [{ id: "s0", text: "α".repeat(500), uncertain: true }],
  });
  assert(payload.tokenUpperBound <= 6000, String(payload.tokenUpperBound));
  assert(payload.messages[0].content.includes("Correzione"));
});
test("A definitive invalid completion is cached with diagnostics and charged only its confirmed usage", async () => {
  let cache: unknown = null,
    reservations = 0,
    providers = 0,
    settled = 0;
  const diagnostics = {
    stage: "structure" as const,
    issueCount: 1,
    issues: [
      {
        path: "sections.0.paragraphs",
        code: "invalid_type",
        expected: "array",
      },
    ],
  };
  const deps: OperationDependencies = {
    notesReservation: 1000,
    read: async () => cache as never,
    reserve: async () => ({
      acquired: ++reservations === 1,
      status: "reserved",
    }),
    cache: async (value) => {
      cache = value;
      return true;
    },
    settle: async (usage) => {
      settled += usage;
    },
    providerError: async (error) => error as RouteError,
  };
  const provider = async (): Promise<never> => {
    providers++;
    const failure = new RouteError(
      502,
      "NOTES_INVALID",
      "Invalid structure",
      null,
      diagnostics,
    );
    failure.confirmedUsage = 321;
    throw failure;
  };
  await assert.rejects(() => performOperation(deps, provider), {
    code: "NOTES_INVALID",
    diagnostics: {
      ...diagnostics,
      usage: { reservedTokens: 1000, confirmedTokens: 321 },
    },
  });
  await assert.rejects(() => performOperation(deps, provider), {
    code: "NOTES_INVALID",
    diagnostics: {
      ...diagnostics,
      usage: { reservedTokens: 1000, confirmedTokens: 321 },
    },
  });
  assert.equal(settled, 321);
  assert.equal(providers, 1);
  assert.equal(reservations, 1);
});
