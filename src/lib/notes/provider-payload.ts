import { buildNotesRequest } from "./prompt";
import type { NotesRequest } from "@/lib/shared/processing";
export const OPENAI_NOTES_MODEL = "gpt-6-luna";
export const OPENROUTER_NOTES_MODEL = "dots-studio/dots-3-note-preview:free";
export function openAiNotesPayload(input: NotesRequest) {
  const common = buildNotesRequest(input);
  return {
    model: OPENAI_NOTES_MODEL,
    reasoning: { mode: "standard" as const, effort: "medium" as const },
    input: common.messages,
    text: {
      format: {
        type: "json_schema" as const,
        ...common.response_format.json_schema,
      },
    },
    max_output_tokens:
      input.mode === "outline"
        ? 6000
        : Math.min(16000, 6000 + input.sources.length * 200),
    store: false,
  };
}
export function openRouterNotesPayload(input: NotesRequest) {
  const common = buildNotesRequest(input);
  return {
    model: OPENROUTER_NOTES_MODEL,
    messages: common.messages,
    response_format: common.response_format,
    reasoning: { enabled: false },
    max_tokens:
      input.mode === "outline"
        ? 2000
        : Math.min(8000, 2000 + input.sources.length * 140),
    stream: false,
    provider: {
      require_parameters: true,
      data_collection: "deny",
      max_price: { prompt: 0, completion: 0, request: 0 },
    },
  };
}
export function lunaCostMicros(input: number, output: number, cached = 0) {
  return Math.ceil(
    Math.max(0, input - cached) * 0.1 + cached * 0.01 + output * 0.5,
  );
}
