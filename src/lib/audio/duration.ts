import { abortIfNeeded } from "./fingerprint";
import { inspectWav } from "./wav";
import { openMp3 } from "./mp3";

/** Metadata only. Never decode a whole recording to PCM for the uploader. */
export async function readAudioDuration(file: File, signal: AbortSignal) {
  abortIfNeeded(signal);
  const wav = await inspectWav(file);
  if (wav) return wav.duration;
  if (/\.mp3$/i.test(file.name) || file.type === "audio/mpeg") {
    const mp3 = await openMp3(
      file,
      signal,
      () => {},
      () => {},
    );
    try {
      return mp3.duration;
    } finally {
      mp3.close();
    }
  }
  abortIfNeeded(signal);
  const audio = document.createElement("audio");
  const url = URL.createObjectURL(file);
  audio.preload = "metadata";
  try {
    return await new Promise<number>((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        audio.onloadedmetadata = null;
        audio.onerror = null;
        if (error) reject(error);
        else if (Number.isFinite(audio.duration) && audio.duration > 0)
          resolve(audio.duration);
        else reject(new Error("Durata non disponibile nei metadati."));
      };
      const abort = () =>
        finish(new DOMException("Lettura interrotta.", "AbortError"));
      const timer = setTimeout(
        () => finish(new Error("Lettura dei metadati scaduta.")),
        15_000,
      );
      audio.onloadedmetadata = () => finish();
      audio.onerror = () =>
        finish(new Error("Il browser non legge i metadati di questo formato."));
      signal.addEventListener("abort", abort, { once: true });
      audio.src = url;
    });
  } finally {
    audio.removeAttribute("src");
    audio.load();
    URL.revokeObjectURL(url);
  }
}
