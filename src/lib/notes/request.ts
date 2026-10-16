import {
  notesOutputSchema,
  outlineOutputSchema,
  NOTES_RESULT_BYTES,
  utf8Bytes,
  type NotesRequest,
  type NotesOutput,
  type OutlineOutput,
} from "@/lib/shared/processing";
import { RouteError } from "@/lib/server/http-core";
import { schemaDiagnostics, outputError, contentError } from "./validation";

export { buildNotesRequest } from "./prompt";

export function validateNotesOutput(
  input: NotesRequest,
  raw: unknown,
): NotesOutput | OutlineOutput {
  if (utf8Bytes(JSON.stringify(raw) ?? "") > NOTES_RESULT_BYTES)
    outputError(
      "NOTES_SIZE",
      "Risposta appunti troppo grande per il recupero sicuro.",
      {
        stage: "size",
        issueCount: 1,
        issues: [{ path: "$", code: "response_too_large" }],
      },
    );
  const allowed = input.sources.map((s) => s.id),
    allowedSet = new Set(allowed);
  if (new Set(allowed).size !== allowed.length)
    throw new RouteError(
      400,
      "DUPLICATE_SOURCES",
      "Riferimenti sorgente duplicati.",
    );
  if (input.mode === "outline") {
    const parsed = outlineOutputSchema.safeParse(raw);
    if (!parsed.success) {
      const diagnostics = schemaDiagnostics(parsed.error.issues);
      outputError(
        "NOTES_INVALID",
        `Struttura dell’indice non valida (${diagnostics.issues[0].path}). La trascrizione è conservata.`,
        diagnostics,
      );
    }
    const data = parsed.data;
    if (!data.chapters.length) contentError("chapters", "NOTES_EMPTY");
    for (const [index, chapter] of data.chapters.entries()) {
      chapter.title = chapter.title.trim();
      if (!chapter.title || !chapter.sectionIds.length)
        contentError(`chapters.${index}`);
    }
    const ids = data.chapters.flatMap((c) => c.sectionIds);
    if (JSON.stringify(ids) !== JSON.stringify(allowed))
      outputError(
        "NOTES_COVERAGE",
        "L’indice non conserva tutte le sezioni nell’ordine originale.",
        {
          stage: "coverage",
          issueCount: 1,
          issues: [
            { path: "chapters.sectionIds", code: "source_order_or_coverage" },
          ],
        },
      );
    return data;
  }
  const parsed = notesOutputSchema.safeParse(raw);
  if (!parsed.success) {
    const diagnostics = schemaDiagnostics(parsed.error.issues);
    const first = diagnostics.issues[0];
    outputError(
      "NOTES_INVALID",
      `Struttura degli appunti non valida (${first.path}${first.expected ? `: atteso ${first.expected}` : ""}). La trascrizione è conservata.`,
      diagnostics,
    );
  }
  const data = parsed.data;
  // These were previously accepted by the stripped provider schema but rejected
  // by local max-count/string constraints. Preserve every substantive item;
  // remove only blank placeholders and duplicate references, never truncate.
  const strings = (items: string[]) =>
    items.map((item) => item.trim()).filter(Boolean);
  const ids = (items: string[]) => [...new Set(strings(items))];
  if (!data.sections.length) contentError("sections", "NOTES_EMPTY");
  for (const [index, section] of data.sections.entries()) {
    section.title = section.title.trim();
    section.paragraphs = strings(section.paragraphs);
    section.bullets = strings(section.bullets);
    section.concepts = strings(section.concepts);
    section.sourceIds = ids(section.sourceIds);
    if (!section.title) contentError(`sections.${index}.title`);
    if (section.title.length > 2000)
      contentError(
        `sections.${index}.title`,
        "NOTES_CONTENT",
        "title_too_long",
      );
    if (
      !section.paragraphs.length &&
      !section.bullets.length &&
      !section.concepts.length
    )
      contentError(`sections.${index}`, "NOTES_EMPTY");
  }
  data.glossary = data.glossary.filter(
    (term) => term.term.trim() || term.definition.trim(),
  );
  for (const [index, term] of data.glossary.entries()) {
    term.term = term.term.trim();
    term.definition = term.definition.trim();
    term.sourceIds = ids(term.sourceIds);
    if (!term.term || !term.definition) contentError(`glossary.${index}`);
  }
  data.uncertainties = data.uncertainties
    .filter((item) => item.text.trim())
    .map((item) => ({
      ...item,
      text: item.text.trim(),
      sourceIds: ids(item.sourceIds),
    }));
  data.coveredSourceIds = ids(data.coveredSourceIds);
  const referenced = [
    ...data.coveredSourceIds,
    ...data.sections.flatMap((s) => s.sourceIds),
    ...data.glossary.flatMap((g) => g.sourceIds),
    ...data.uncertainties.flatMap((u) => u.sourceIds),
  ];
  const covered = new Set(data.coveredSourceIds),
    sectionSources = new Set(data.sections.flatMap((s) => s.sourceIds));
  const uncertain = new Set(data.uncertainties.flatMap((u) => u.sourceIds));
  if (
    data.sections.some((section) => !section.sourceIds.length) ||
    data.glossary.some((term) => !term.sourceIds.length) ||
    data.uncertainties.some((item) => !item.sourceIds.length) ||
    referenced.some((id) => !allowedSet.has(id)) ||
    allowed.some((id) => !covered.has(id) || !sectionSources.has(id)) ||
    input.sources.some((s) => s.uncertain && !uncertain.has(s.id))
  )
    outputError(
      "NOTES_COVERAGE",
      "Gli appunti non coprono tutte le fonti o omettono un passaggio incerto. L’unità non è stata marcata completa.",
      {
        stage: "coverage",
        issueCount: 1,
        issues: [
          { path: "sourceIds", code: "missing_unknown_or_uncertain_sources" },
        ],
      },
    );
  return data;
}
