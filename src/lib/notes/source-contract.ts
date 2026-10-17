import { z } from "zod";
import {
  notesOutputSchema,
  type NotesRequest,
  type NotesOutput,
} from "@/lib/shared/processing";
import { schemaDiagnostics, outputError, contentError } from "./validation";

const sourceEntry = notesOutputSchema.shape.sections.element.omit({
  title: true,
  sourceIds: true,
});
export function sourceMapContract(input: NotesRequest) {
  const sourceIds = input.sources.map((source) => source.id) as [
    string,
    ...string[],
  ];
  return z
    .object({
      title: z.string(),
      sourceNotes: z
        .object(Object.fromEntries(sourceIds.map((id) => [id, sourceEntry])))
        .strict(),
      glossary: z.array(
        z
          .object({
            term: z.string(),
            definition: z.string(),
            sourceId: z.enum(sourceIds),
          })
          .strict(),
      ),
    })
    .strict();
}
export function sourceMapOutput(
  input: NotesRequest,
  raw: unknown,
): NotesOutput {
  const parsed = sourceMapContract(input).safeParse(raw);
  if (!parsed.success)
    outputError(
      "NOTES_INVALID",
      "La risposta non contiene una voce valida per ogni fonte. La trascrizione è conservata.",
      schemaDiagnostics(parsed.error.issues),
    );
  const data = parsed.data;
  const paragraphs: string[] = [],
    bullets: string[] = [],
    concepts: string[] = [];
  for (const [index, source] of input.sources.entries()) {
    const entry = data.sourceNotes[source.id];
    const clean = (items: string[]) =>
      items.map((item) => item.trim()).filter(Boolean);
    const p = clean(entry.paragraphs),
      b = clean(entry.bullets),
      c = clean(entry.concepts);
    // Required keys alone are insufficient: each source must contain real notes
    // before its citation can be attached to the assembled section.
    if (!p.length && !b.length && !c.length)
      contentError(`sourceNotes.${index}`, "NOTES_EMPTY");
    paragraphs.push(...p);
    bullets.push(...b);
    concepts.push(...c);
  }
  const ids = input.sources.map((source) => source.id);
  return {
    sections: [
      { title: data.title, paragraphs, bullets, concepts, sourceIds: ids },
    ],
    glossary: data.glossary.map(({ term, definition, sourceId }) => ({
      term,
      definition,
      sourceIds: [sourceId],
    })),
    uncertainties: [],
    coveredSourceIds: ids,
  };
}
