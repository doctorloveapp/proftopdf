import { z } from "zod";
import { notesOutputSchema, type NotesRequest } from "@/lib/shared/processing";
// Pure client/server contract builder. No validation/server dependencies in the
// lazy browser token-budget bundle. Inline schema is accepted by Groq strict mode.
export function sourceMapJsonSchema(input: NotesRequest) {
  const entry = z.toJSONSchema(
    notesOutputSchema.shape.sections.element.omit({
      title: true,
      sourceIds: true,
    }),
  );
  const { $schema: _schema, ...item } = entry;
  const ids = input.sources.map((source) => source.id);
  return {
    type: "object",
    additionalProperties: false,
    required: ["title", "sourceNotes", "glossary"],
    properties: {
      title: { type: "string" },
      sourceNotes: {
        type: "object",
        additionalProperties: false,
        required: ids,
        properties: Object.fromEntries(ids.map((id) => [id, item])),
      },
      glossary: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["term", "definition", "sourceId"],
          properties: {
            term: { type: "string" },
            definition: { type: "string" },
            sourceId: { type: "string", enum: ids },
          },
        },
      },
    },
  };
}
