export const SUBJECTS = [
  "Italiano",
  "Latino",
  "Greco",
  "Storia",
  "Filosofia",
  "Matematica",
  "Scienze",
  "Inglese",
] as const;
export const LANGUAGE_POLICY_REVISION = "original-languages-v1";
export const TRANSCRIPTION_PROFILES = [
  "general",
  "english",
  "latin",
  "ancient-greek",
] as const;
export type TranscriptionProfile = (typeof TRANSCRIPTION_PROFILES)[number];

export function transcriptionProfile(subject: string): TranscriptionProfile {
  switch (subject.trim().toLocaleLowerCase("it")) {
    case "inglese":
      return "english";
    case "latino":
      return "latin";
    case "greco":
      return "ancient-greek";
    default:
      return "general";
  }
}
// Whisper uses a context prompt, not a chat system prompt. Never force one
// language for mixed speech or send the audio to a translation endpoint.
export function transcriptionContext(profile: TranscriptionProfile) {
  switch (profile) {
    case "english":
      return "Lezione di inglese con spiegazioni in italiano e interventi in English, riportati nella lingua parlata.";
    case "latin":
      return "Lezione di latino: spiegazioni in italiano, parole e citazioni in lingua latina, riportate nella lingua originale.";
    case "ancient-greek":
      return "Lezione di greco antico scolastico: spiegazioni in italiano, parole e letture in greco antico con alfabeto greco, spiriti e accenti.";
    default:
      return undefined;
  }
}
export function notesLanguageGuidance(subject: string) {
  const common =
    "Conserva la lingua delle fonti: italiano in italiano, inglese in inglese, latino in latino, greco in greco. Non tradurre né italianizzare termini, citazioni o interi passaggi; conserva solo le traduzioni già presenti nelle fonti. Non ricostruire parole incerte.";
  switch (transcriptionProfile(subject)) {
    case "english":
      return `${common} Inglese: mantieni anche frasi, esempi e spiegazioni interamente inglesi in inglese.`;
    case "latin":
      return `${common} Latino: conserva forme, desinenze e citazioni latine; la spiegazione italiana resta italiana.`;
    case "ancient-greek":
      return `${common} Greco antico scolastico: conserva alfabeto, spiriti e accenti presenti; non modernizzare né traslitterare il greco.`;
    default:
      return common;
  }
}
