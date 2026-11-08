import { PROCESSING_REVISION } from "@/lib/shared/processing";
import { LANGUAGE_POLICY_REVISION } from "@/lib/shared/lecture";

export function transcriptionUnit(input: {
  index: number;
  model: string;
  attempt: number;
  languageMode: "it" | "auto";
  profile: string;
  generation?: number;
}) {
  const base =
    input.languageMode === "it"
      ? `${PROCESSING_REVISION}:${input.index}:${input.model}:${input.attempt}`
      : `${PROCESSING_REVISION}:${LANGUAGE_POLICY_REVISION}:${input.profile}:${input.index}:${input.model}:${input.attempt}`;
  return input.generation ? `${base}:audio-r${input.generation}` : base;
}
