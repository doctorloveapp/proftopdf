import { AUDIO_LIMITS } from "@/lib/shared/constants";
import { abortIfNeeded } from "./fingerprint";

export async function openAudioWorker(file: File, signal: AbortSignal) {
  // Load the official unmodified wrapper as a same-origin ESM asset. Its
  // dynamic Worker URL cannot be statically resolved by Turbopack.
  const assetPath = "/ffmpeg/v0.12.15-core0.12.10";
  const wrapperURL = new URL(`${assetPath}/index.js`, window.location.origin)
    .href;
  const { FFmpeg, FFFSType } = (await import(
    /* webpackIgnore: true */ wrapperURL
  )) as typeof import("@ffmpeg/ffmpeg");
  abortIfNeeded(signal);
  const engine = new FFmpeg();
  const terminate = () => engine.terminate();
  signal.addEventListener("abort", terminate, { once: true });
  async function probe(path: string) {
    const code = await engine.ffprobe(
      [
        "-v",
        "error",
        "-select_streams",
        "a:0",
        "-show_entries",
        "format=duration,bit_rate:stream=codec_name,duration",
        "-of",
        "json",
        path,
        "-o",
        "/probe.json",
      ],
      30_000,
    );
    if (code !== 0)
      throw new Error(
        "Impossibile leggere l’audio. Verifica che il file sia completo.",
      );
    try {
      const raw = await engine.readFile("/probe.json", "utf8");
      const data = JSON.parse(String(raw));
      const stream = data.streams?.[0];
      const duration = Number(stream?.duration ?? data.format?.duration);
      if (!stream || !Number.isFinite(duration) || duration <= 0)
        throw new Error("Durata non disponibile.");
      return {
        duration,
        codec: String(stream.codec_name),
        bitrate: Number(data.format?.bit_rate) || (file.size * 8) / duration,
      };
    } finally {
      await engine.deleteFile("/probe.json").catch(() => {});
    }
  }
  try {
    await engine.load({
      classWorkerURL: new URL(`${assetPath}/worker.js`, window.location.origin)
        .href,
      coreURL: new URL(
        `${assetPath}/core/ffmpeg-core.js`,
        window.location.origin,
      ).href,
      wasmURL: new URL(
        `${assetPath}/core/ffmpeg-core.wasm`,
        window.location.origin,
      ).href,
    });
    await engine.createDir("/input");
    if (
      !(await engine.mount(
        FFFSType.WORKERFS,
        { blobs: [{ name: "source", data: file }] },
        "/input",
      ))
    )
      throw new Error(
        "Questo dispositivo non supporta la lettura progressiva richiesta.",
      );
    const source = await probe("/input/source");
    return {
      duration: source.duration,
      estimatedBytes: ["aac", "mp3", "flac"].includes(source.codec)
        ? Math.ceil(file.size * 1.05)
        : Math.ceil(source.duration * 32_000 * 1.05),
      async chunk(start: number) {
        abortIfNeeded(signal);
        const copy = ["aac", "mp3", "flac"].includes(source.codec);
        const extension =
          source.codec === "aac"
            ? "m4a"
            : source.codec === "mp3"
              ? "mp3"
              : "flac";
        let span = copy
          ? Math.min(
              180,
              ((AUDIO_LIMITS.maxChunkBytes - 100_000) * 8) / source.bitrate,
            )
          : 90;
        span = Math.max(1, Math.min(span, source.duration - start));
        for (let attempt = 0; attempt < 8; attempt++) {
          abortIfNeeded(signal);
          const path = `/chunk.${copy ? extension : "wav"}`;
          try {
            const args = [
              "-ss",
              String(start),
              "-i",
              "/input/source",
              "-t",
              String(span),
              "-map",
              "0:a:0",
              "-vn",
              "-map_metadata",
              "-1",
            ];
            args.push(
              ...(copy
                ? [
                    "-c:a",
                    "copy",
                    "-avoid_negative_ts",
                    "make_zero",
                    "-fs",
                    String(AUDIO_LIMITS.maxChunkBytes + 1),
                  ]
                : ["-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le"]),
            );
            if (copy && extension === "m4a")
              args.push("-movflags", "+faststart");
            const code = await engine.exec([...args, "-y", path], 120_000);
            if (code !== 0)
              throw new Error(
                "Non è stato possibile preparare questo formato audio.",
              );
            const details = await probe(path);
            const raw = await engine.readFile(path);
            if (!(raw instanceof Uint8Array))
              throw new Error("Segmento audio non valido.");
            if (
              raw.byteLength > AUDIO_LIMITS.maxChunkBytes ||
              details.duration > AUDIO_LIMITS.maxChunkDurationSeconds ||
              details.duration + 0.25 < span
            ) {
              span *= 0.65;
              continue;
            }
            if (details.duration <= 0.01)
              throw new Error("Segmento audio vuoto.");
            const blob = new Blob([new Uint8Array(raw)], {
              type: copy
                ? extension === "m4a"
                  ? "audio/mp4"
                  : extension === "mp3"
                    ? "audio/mpeg"
                    : "audio/flac"
                : "audio/wav",
            });
            return {
              blob,
              startSeconds: start,
              endSeconds: Math.min(source.duration, start + details.duration),
              codec: copy ? source.codec : "pcm_s16le",
              container: copy ? extension : "wav",
            };
          } finally {
            await engine.deleteFile(path).catch(() => {});
          }
        }
        throw new Error(
          "Non è stato possibile ottenere un segmento sotto 3,2 MB.",
        );
      },
      close() {
        signal.removeEventListener("abort", terminate);
        engine.terminate();
      },
    };
  } catch (error) {
    signal.removeEventListener("abort", terminate);
    engine.terminate();
    throw error;
  }
}
