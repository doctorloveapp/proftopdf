import { MAX_AUDIO_PARTS } from "@/lib/audio/timeline";
import { AudioProcessingError } from "@/lib/audio/errors";

export interface AudioFileHandle {
  getFile(): Promise<File>;
}
export interface AudioPickerOptions {
  id: string;
  multiple: true;
  excludeAcceptAllOption: false;
  startIn?: AudioFileHandle;
  types?: { description: string; accept: Record<string, string[]> }[];
}
export type NativeAudioPicker = (
  options: AudioPickerOptions,
) => Promise<AudioFileHandle[]>;
export const AUDIO_PICKER_ID = "proftopdf-recordings";

/** Stable ID lets the browser remember the directory across dialogs/sessions.
 * A selected handle also supplies startIn within this page. Never infer a real
 * path from input.value, request write access, or persist recording contents. */
export function createAudioPicker(
  getPicker: () => NativeAudioPicker | undefined,
) {
  let lastHandle: AudioFileHandle | undefined;
  return {
    canRememberLocation: () => Boolean(getPicker()),
    async open(allFiles = false): Promise<File[] | null> {
      const pick = getPicker();
      if (!pick) return null;
      let handles: AudioFileHandle[];
      try {
        handles = await pick({
          id: AUDIO_PICKER_ID,
          multiple: true,
          excludeAcceptAllOption: false,
          ...(lastHandle ? { startIn: lastHandle } : {}),
          ...(!allFiles
            ? {
                types: [
                  {
                    description: "Registrazioni audio",
                    accept: {
                      "audio/*": [
                        ".m4a",
                        ".aac",
                        ".mp3",
                        ".wav",
                        ".flac",
                        ".ogg",
                        ".webm",
                      ],
                      "video/mp4": [".mp4"],
                    },
                  },
                ],
              }
            : {}),
        });
      } catch (error) {
        const name = (error as { name?: string })?.name;
        if (name === "AbortError") return [];
        if (name === "NotFoundError") lastHandle = undefined;
        throw error;
      }
      if (handles.length > MAX_AUDIO_PARTS)
        throw new AudioProcessingError(
          "AUDIO_SELECTION_LIMIT",
          "selection",
          `Puoi scegliere al massimo ${MAX_AUDIO_PARTS} spezzoni per lezione.`,
        );
      const files: File[] = [];
      for (const handle of handles) files.push(await handle.getFile());
      if (files.length) lastHandle = handles[0];
      return files;
    },
  };
}
// Shared across component remounts/new lessons; UA retains the stable ID.
export const audioPicker = createAudioPicker(() => {
  if (typeof window === "undefined") return undefined;
  const pick = (window as unknown as { showOpenFilePicker?: NativeAudioPicker })
    .showOpenFilePicker;
  return typeof pick === "function" ? pick.bind(window) : undefined;
});
