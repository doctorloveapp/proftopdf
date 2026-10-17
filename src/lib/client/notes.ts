import { api, ClientApiError } from "./api";
import {
  LLM_ROUTING_REVISION,
  type NotesRemote,
  type NotesRequest,
  type NotesOutput,
  type OutlineOutput,
} from "@/lib/shared/processing";
import { createAudioLog } from "@/lib/audio/diagnostics";
export async function requestNotes(
  input: NotesRequest,
  csrfToken: string,
  signal: AbortSignal,
): Promise<NotesOutput | OutlineOutput> {
  for (let hops = 0; hops < 5; hops++) {
    const result = await api<NotesRemote>("/api/notes", {
      method: "POST",
      signal,
      body: JSON.stringify(input),
      headers: {
        "Content-Type": "application/json",
        "x-csrf-token": csrfToken,
        "x-notes-routing-version": LLM_ROUTING_REVISION,
      },
    });
    if (!("state" in result)) return result;
    createAudioLog(input.jobId)(`llm.${result.state}`, {
      provider: result.provider,
      unit: input.unitId,
    });
    if (result.state === "rebatch")
      throw new ClientApiError(
        "Il fallback Groq richiede gruppi più piccoli; ripianificazione automatica.",
        413,
        null,
        "NOTES_REBATCH",
        result.usage
          ? { stage: "quota", issueCount: 0, issues: [], usage: result.usage }
          : undefined,
      );
  }
  throw new ClientApiError(
    "Il cambio del motore non si è concluso. Il lavoro è salvato.",
    503,
    null,
    "LLM_UNAVAILABLE",
  );
}
