import { AUDIO_LIMITS } from "@/lib/shared/constants";
import { abortIfNeeded } from "./fingerprint";
import { audioOperation, audioFailure, AudioProcessingError } from "./errors";
import { parseAudioProbe } from "./probe";
import type { AudioLog } from "./diagnostics";

export async function openAudioWorker(
  file: File,
  signal: AbortSignal,
  log: AudioLog = () => {},
) {
  // Load the official unmodified wrapper as a same-origin ESM asset. Its
  // dynamic Worker URL cannot be statically resolved by Turbopack.
  const assetPath = "/ffmpeg/v0.12.15-core0.12.10";
  const wrapperURL = new URL(`${assetPath}/index.js`, window.location.origin)
    .href;
  let engine: InstanceType<typeof import("@ffmpeg/ffmpeg").FFmpeg> | undefined;
  let phase = "assets";
  const terminate = () => engine?.terminate();
  async function run<T>(
    name: string,
    timeout: number,
    operation: () => Promise<T>,
  ) {
    phase = name;
    const started = performance.now();
    log(`worker.${name}.start`, { timeoutMs: timeout });
    try {
      const value = await audioOperation(
        operation,
        name,
        timeout,
        signal,
        terminate,
      );
      log(`worker.${name}.complete`, {
        durationMs: Math.round(performance.now() - started),
      });
      return value;
    } catch (error) {
      if (signal.aborted) throw error;
      const failure = audioFailure(error, name);
      log(
        `worker.${name}.failed`,
        { code: failure.code, ...failure.details },
        "error",
      );
      throw failure;
    }
  }
  // HEAD checks status/MIME without downloading the core twice. GET remains
  // the official loader's job; an outer watchdog covers download/compile hangs.
  for (const asset of [
    "index.js",
    "worker.js",
    "core/ffmpeg-core.js",
    "core/ffmpeg-core.wasm",
  ]) {
    await run("asset", 25_000, async () => {
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal.addEventListener("abort", abort, { once: true });
      const timeout = setTimeout(abort, 24_000);
      try {
        const response = await fetch(
          new URL(`${assetPath}/${asset}`, window.location.origin),
          { method: "HEAD", signal: controller.signal },
        );
        const mime = response.headers.get("content-type") ?? "missing";
        log("worker.asset.response", { asset, status: response.status, mime });
        if (!response.ok)
          throw new AudioProcessingError(
            "AUDIO_ASSET_HTTP",
            "assets",
            `Download del motore non disponibile: HTTP ${response.status} (${asset}).`,
            { asset, status: response.status },
          );
        const valid = asset.endsWith(".wasm")
          ? /^application\/wasm\b/i.test(mime)
          : /(?:javascript|ecmascript)/i.test(mime);
        if (!valid)
          throw new AudioProcessingError(
            "AUDIO_ASSET_MIME",
            "assets",
            `Il server invia un tipo di file errato per ${asset}.`,
            { asset, mime },
          );
      } catch (error) {
        if (controller.signal.aborted && !signal.aborted)
          throw new AudioProcessingError(
            "AUDIO_ASSET_TIMEOUT",
            "assets",
            `Download del motore troppo lento (${asset}). Verifica la connessione.`,
            { asset, timeoutMs: 24_000 },
          );
        throw error;
      } finally {
        clearTimeout(timeout);
        signal.removeEventListener("abort", abort);
      }
    });
  }
  const { FFmpeg, FFFSType } = await run(
    "import",
    30_000,
    async () =>
      (await import(
        /* webpackIgnore: true */ wrapperURL
      )) as typeof import("@ffmpeg/ffmpeg"),
  );
  abortIfNeeded(signal);
  const audio = new FFmpeg();
  engine = audio;
  let stderr: string[] = [];
  audio.on("log", ({ type, message }) => {
    if (type !== "stderr" || !message.trim()) return;
    // Emscripten's CLI exit path emits this exact line even with exitCode 0.
    // Nonzero exit codes and Aborted(reason) are still treated as failures.
    if (message.trim() === "Aborted()") {
      log("worker.runtime.exit", { phase, message: "Aborted()" });
      return;
    }
    // -v error / -hide_banner avoid content metadata; paths are virtual names.
    const safe = message.replace(/https?:\/\/\S+/g, "[url]").slice(0, 500);
    stderr.push(safe);
    stderr = stderr.slice(-10);
    log("worker.stderr", { phase, message: safe }, "error");
  });
  signal.addEventListener("abort", terminate, { once: true });
  let probeIndex = 0;
  async function probe(path: string) {
    const output = `/probe-${probeIndex++}.json`;
    stderr = [];
    const code = await run("probe", 100_000, () =>
      audio.ffprobe(
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
          output,
        ],
        90_000,
      ),
    );
    log("worker.probe.exit", { exitCode: code, stderrLines: stderr.length });
    try {
      const raw = await run("probe-read", 15_000, () =>
        audio.readFile(output, "utf8"),
      );
      const data = parseAudioProbe(code, String(raw), stderr);
      log("worker.probe.validated", {
        exitCode: code,
        durationSeconds: data.duration,
        codec: data.codec,
        sentinelValidated: code === -1,
      });
      return {
        ...data,
        bitrate: data.bitrate || (file.size * 8) / data.duration,
      };
    } finally {
      await audio.deleteFile(output).catch(() => {});
    }
  }
  try {
    await run("load", 180_000, () =>
      audio.load({
        classWorkerURL: new URL(
          `${assetPath}/worker.js`,
          window.location.origin,
        ).href,
        coreURL: new URL(
          `${assetPath}/core/ffmpeg-core.js`,
          window.location.origin,
        ).href,
        wasmURL: new URL(
          `${assetPath}/core/ffmpeg-core.wasm`,
          window.location.origin,
        ).href,
      }),
    );
    await run("mkdir", 15_000, () => audio.createDir("/input"));
    if (
      !(await run("mount", 30_000, () =>
        audio.mount(
          FFFSType.WORKERFS,
          { blobs: [{ name: "source", data: file }] },
          "/input",
        ),
      ))
    )
      throw new AudioProcessingError(
        "AUDIO_MOUNT_UNSUPPORTED",
        "mount",
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
              "-hide_banner",
              "-v",
              "error",
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
            stderr = [];
            const code = await run("segment", 190_000, () =>
              audio.exec([...args, "-y", path], 180_000),
            );
            if (code !== 0 || stderr.length)
              throw new AudioProcessingError(
                "AUDIO_SEGMENT_FAILED",
                "segment",
                "FFmpeg non ha completato il segmento. Esporta il log per il dettaglio tecnico.",
                {
                  exitCode: code,
                  stderr: stderr.join("\n"),
                  requestedStart: start,
                  requestedSpan: span,
                },
              );
            const details = await probe(path);
            const raw = await run("segment-read", 15_000, () =>
              audio.readFile(path),
            );
            if (!(raw instanceof Uint8Array))
              throw new Error("Segmento audio non valido.");
            if (
              raw.byteLength > AUDIO_LIMITS.maxChunkBytes ||
              details.duration > AUDIO_LIMITS.maxChunkDurationSeconds ||
              details.duration + 0.25 < span
            ) {
              log("worker.segment.retry", {
                attempt,
                bytes: raw.byteLength,
                actualSeconds: details.duration,
                requestedSeconds: span,
              });
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
            await audio.deleteFile(path).catch(() => {});
          }
        }
        throw new Error(
          "Non è stato possibile ottenere un segmento sotto 3,2 MB.",
        );
      },
      close() {
        signal.removeEventListener("abort", terminate);
        terminate();
      },
    };
  } catch (error) {
    signal.removeEventListener("abort", terminate);
    terminate();
    if (signal.aborted) throw error;
    throw audioFailure(error, phase);
  }
}
