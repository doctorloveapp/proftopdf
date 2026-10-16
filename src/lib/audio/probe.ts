import { AudioProcessingError } from "./errors";

export function parseAudioProbe(
  exitCode: number,
  raw: string,
  stderr: string[],
) {
  // @ffmpeg/core 0.12.10 leaves Module.ret at its reset sentinel (-1) on
  // ffprobe success AND failure. Never accept that sentinel without checking
  // fresh JSON, an audio stream, finite duration and absence of error output.
  const details = { exitCode, stderr: stderr.slice(-6).join("\n") };
  if (![0, -1].includes(exitCode) || stderr.length)
    throw new AudioProcessingError(
      "AUDIO_PROBE_FAILED",
      "probe",
      "Analisi audio fallita nel motore FFmpeg. Esporta il log diagnostico per leggere il dettaglio tecnico.",
      details,
    );
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new AudioProcessingError(
      "AUDIO_PROBE_JSON",
      "probe",
      "Il motore non ha prodotto un’analisi audio valida.",
      details,
    );
  }
  const stream = data?.streams?.[0];
  const streamDuration = Number(stream?.duration);
  const duration =
    Number.isFinite(streamDuration) && streamDuration > 0
      ? streamDuration
      : Number(data?.format?.duration);
  if (
    !stream ||
    typeof stream.codec_name !== "string" ||
    !Number.isFinite(duration) ||
    duration <= 0
  )
    throw new AudioProcessingError(
      "AUDIO_PROBE_DURATION",
      "probe",
      "Traccia audio o durata non disponibile. Il formato potrebbe non essere supportato.",
      details,
    );
  const bitrate = Number(data?.format?.bit_rate);
  return {
    duration,
    codec: stream.codec_name as string,
    bitrate: Number.isFinite(bitrate) && bitrate > 0 ? bitrate : 0,
  };
}
