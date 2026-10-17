import { abortIfNeeded } from "./fingerprint";
import { inspectWav } from "./wav";
import { openMp3 } from "./mp3";
import { readMp4Duration } from "./mp4-duration";
import { AudioProcessingError } from "./errors";

export type DurationDiagnostic = (details: {
  engine: "wav-js" | "mp3-js" | "mp4-js" | "browser";
  durationSeconds?: number;
  bytesRead?: number;
  boxesRead?: number;
  code?: string;
}) => void;

/** Metadata only. Never decode a whole recording to PCM for the uploader. */
export async function readAudioDuration(
  file: File,
  signal: AbortSignal,
  diagnostic: DurationDiagnostic = () => {},
) {
  abortIfNeeded(signal);
  const wav = await inspectWav(file);
  if (wav) {
    diagnostic({ engine: "wav-js", durationSeconds: wav.duration });
    return wav.duration;
  }
  if (/\.mp3$/i.test(file.name) || file.type === "audio/mpeg") {
    const mp3 = await openMp3(
      file,
      signal,
      () => {},
      () => {},
    );
    try {
      diagnostic({ engine: "mp3-js", durationSeconds: mp3.duration });
      return mp3.duration;
    } finally {
      mp3.close();
    }
  }
  if (
    /\.(m4a|mp4)$/i.test(file.name) ||
    /^(audio|video)\/(mp4|x-m4a)$/i.test(file.type)
  ) {
    try {
      const result = await readMp4Duration(file, signal);
      if (result) {
        diagnostic({
          engine: "mp4-js",
          durationSeconds: result.seconds,
          bytesRead: result.bytesRead,
          boxesRead: result.boxesRead,
        });
        return result.seconds;
      }
      diagnostic({ engine: "mp4-js", code: "AUDIO_METADATA_UNKNOWN" });
    } catch (error) {
      abortIfNeeded(signal);
      diagnostic({
        engine: "mp4-js",
        code:
          error instanceof AudioProcessingError
            ? error.code
            : "AUDIO_METADATA_READ",
      });
    }
  }
  abortIfNeeded(signal);
  const audio = document.createElement("audio");
  // Normalize MIME hints for recordings supplied with generic/incorrect types.
  const source = /\.(m4a|mp4)$/i.test(file.name)
    ? file.slice(0, file.size, "audio/mp4")
    : file;
  const url = URL.createObjectURL(source);
  audio.preload = "metadata";
  try {
    const seconds = await new Promise<number>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        audio.onloadedmetadata = null;
        audio.ondurationchange = null;
        audio.onerror = null;
        if (error) reject(error);
        else if (Number.isFinite(audio.duration) && audio.duration > 0)
          resolve(audio.duration);
        else
          reject(
            new AudioProcessingError(
              "AUDIO_METADATA_UNKNOWN",
              "metadata",
              "Durata non disponibile nei metadati.",
            ),
          );
      };
      const abort = () =>
        finish(new DOMException("Lettura interrotta.", "AbortError"));
      const timer = setTimeout(
        () =>
          finish(
            new AudioProcessingError(
              "AUDIO_METADATA_TIMEOUT",
              "metadata",
              "Lettura dei metadati scaduta.",
            ),
          ),
        15_000,
      );
      // Some browsers first report Infinity, then publish a finite duration.
      const available = () => {
        if (Number.isFinite(audio.duration) && audio.duration > 0) finish();
      };
      audio.onloadedmetadata = available;
      audio.ondurationchange = available;
      audio.onerror = () =>
        finish(
          new AudioProcessingError(
            "AUDIO_METADATA_FORMAT",
            "metadata",
            "Il browser non legge i metadati di questo formato.",
          ),
        );
      signal.addEventListener("abort", abort, { once: true });
      audio.src = url;
    });
    diagnostic({ engine: "browser", durationSeconds: seconds });
    return seconds;
  } catch (error) {
    if (!signal.aborted)
      diagnostic({
        engine: "browser",
        code:
          error instanceof AudioProcessingError
            ? error.code
            : "AUDIO_METADATA_READ",
      });
    throw error;
  } finally {
    audio.removeAttribute("src");
    audio.load();
    URL.revokeObjectURL(url);
  }
}
