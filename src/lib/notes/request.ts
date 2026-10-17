import {
  notesOutputSchema,
  outlineOutputSchema,
  NOTES_RESULT_BYTES,
  STT_UNCERTAINTY_NOTICE,
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
  // The model supplies academic content and its citations. Coverage metadata
  // and STT warnings belong to the application; also accept old full outputs.
  const withMetadata =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? { coveredSourceIds: [], uncertainties: [], ...raw }
      : raw;
  const parsed = notesOutputSchema.safeParse(withMetadata);
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
  const issues: { path: string; code: string }[] = [];
  let unknownReferenceCount = 0,
    emptyReferenceCount = 0;
  for (const [field, entries] of [
    ["sections", data.sections],
    ["glossary", data.glossary],
    ["uncertainties", data.uncertainties],
  ] as const)
    for (const [index, entry] of entries.entries()) {
      if (!entry.sourceIds.length) {
        emptyReferenceCount++;
        issues.push({
          path: `${field}.${index}.sourceIds`,
          code: "empty_source_references",
        });
      }
      for (const [refIndex, id] of entry.sourceIds.entries())
        if (!allowedSet.has(id)) {
          unknownReferenceCount++;
          // Only numeric locations, never the unexpected model-generated ID.
          issues.push({
            path: `${field}.${index}.sourceIds.${refIndex}`,
            code: "unknown_source_reference",
          });
        }
    }
  const sectionSources = new Set(data.sections.flatMap((s) => s.sourceIds));
  const missing = allowed.filter((id) => !sectionSources.has(id));
  for (const id of missing)
    issues.push({
      path: `sources.${allowed.indexOf(id)}`,
      code: "source_not_linked_to_section",
    });
  if (issues.length)
    outputError(
      "NOTES_COVERAGE",
      `Riferimenti degli appunti da correggere: ${missing.length} fonti assenti dalle sezioni, ${unknownReferenceCount} riferimenti sconosciuti, ${emptyReferenceCount} elenchi di riferimenti vuoti. La trascrizione è conservata.`,
      {
        stage: "coverage",
        issueCount: issues.length,
        issues: issues.slice(0, 6),
        coverage: {
          sourceCount: allowed.length,
          missingSectionSourceCount: missing.length,
          unknownReferenceCount,
          emptyReferenceCount,
        },
      },
    );
  // Coverage is derived from validated section references, never from the
  // model's redundant self-reported list. Missing real references still fail.
  data.coveredSourceIds = allowed.filter((id) => sectionSources.has(id));
  // STT flags are facts already known to the application, not a task to repeat
  // perfectly in each LLM response. Preserve them deterministically in notes.
  const warned = new Set(data.uncertainties.flatMap((u) => u.sourceIds));
  const unwarned = input.sources
    .filter((source) => source.uncertain && !warned.has(source.id))
    .map((source) => source.id);
  if (unwarned.length)
    data.uncertainties.push({
      text: STT_UNCERTAINTY_NOTICE,
      sourceIds: unwarned,
    });
  if (utf8Bytes(JSON.stringify(data)) > NOTES_RESULT_BYTES)
    outputError(
      "NOTES_SIZE",
      "Gli appunti normalizzati superano il limite di recupero sicuro.",
      {
        stage: "size",
        issueCount: 1,
        issues: [{ path: "$", code: "normalized_response_too_large" }],
      },
    );
  return data;
}
