import {
  NOTES_RESULT_BYTES,
  utf8Bytes,
  type NotesRequest,
} from "@/lib/shared/processing";
import { validateNotesOutput } from "./request";
import { outputError } from "./validation";
import { sourceMapOutput } from "./source-contract";

/** No partial JSON, guessed fields, text excerpts or model-error strings. */
export function acceptNotesCompletion(
  input: NotesRequest,
  finishReason: string | undefined,
  content: string | null | undefined,
) {
  if (finishReason !== "stop" || !content)
    outputError(
      "NOTES_TRUNCATED",
      "Il modello non ha completato questa unità di appunti. La trascrizione è conservata.",
      {
        stage: "completion",
        issueCount: 1,
        issues: [
          {
            path: "$",
            code:
              finishReason === "length"
                ? "completion_token_limit"
                : "incomplete_response",
            expected: "stop",
          },
        ],
      },
    );
  if (utf8Bytes(content) > NOTES_RESULT_BYTES)
    outputError(
      "NOTES_SIZE",
      "Risposta appunti troppo grande per il recupero sicuro.",
      {
        stage: "size",
        issueCount: 1,
        issues: [{ path: "$", code: "response_too_large" }],
      },
    );
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    outputError(
      "NOTES_JSON",
      "Il modello ha restituito JSON non leggibile. La trascrizione è conservata.",
      {
        stage: "json",
        issueCount: 1,
        issues: [{ path: "$", code: "invalid_json" }],
      },
    );
  }
  const mapped =
    input.mode === "notes" &&
    raw &&
    typeof raw === "object" &&
    "sourceNotes" in raw
      ? sourceMapOutput(input, raw)
      : raw;
  return validateNotesOutput(input, mapped);
}
