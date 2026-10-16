import { AUDIO_LIMITS } from "@/lib/shared/constants";
import { inspectWav } from "@/lib/audio/wav";
import { openMp3 } from "@/lib/audio/mp3";
import { RouteError } from "./http-core";

function invalid(
  message = "Contenitore audio non verificabile. Esporta questo segmento come WAV o MP3 standard.",
): never {
  throw new RouteError(422, "AUDIO_INVALID", message);
}
interface Box {
  type: string;
  start: number;
  data: number;
  end: number;
}
// ISO BMFF: parse only bounded boxes needed to verify AAC sample timing.
// No filename, MIME or client-supplied duration is trusted.
function mp4Duration(bytes: Uint8Array) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  const str = (p: number, n: number) =>
    String.fromCharCode(...bytes.subarray(p, p + n));
  let totalBoxes = 0;
  function boxes(start: number, end: number): Box[] {
    const result: Box[] = [];
    while (start < end) {
      if (++totalBoxes > 4096 || start + 8 > end) invalid();
      let size = v.getUint32(start),
        head = 8;
      if (size === 1) {
        if (start + 16 > end) invalid();
        size = Number(v.getBigUint64(start + 8));
        head = 16;
      }
      if (size === 0) size = end - start;
      if (!Number.isSafeInteger(size) || size < head || start + size > end)
        invalid();
      result.push({
        type: str(start + 4, 4),
        start,
        data: start + head,
        end: start + size,
      });
      start += size;
    }
    return result;
  }
  const child = (box: Box, name: string) => {
    const found = boxes(box.data, box.end).find((b) => b.type === name);
    if (!found) invalid();
    return found;
  };
  const top = boxes(0, bytes.length),
    moov = top.find((b) => b.type === "moov");
  const mdats = top.filter((b) => b.type === "mdat");
  if (!moov || !mdats.length || top.some((b) => b.type === "moof")) invalid();
  const tracks = boxes(moov.data, moov.end).filter((b) => b.type === "trak");
  if (tracks.length !== 1)
    invalid("Il segmento deve contenere una sola traccia audio.");
  const mdia = child(tracks[0], "mdia"),
    hdlr = child(mdia, "hdlr");
  if (hdlr.data + 12 > hdlr.end || str(hdlr.data + 8, 4) !== "soun") invalid();
  const mdhd = child(mdia, "mdhd"),
    scaleOffset = mdhd.data + (bytes[mdhd.data] === 1 ? 20 : 12);
  if (scaleOffset + 4 > mdhd.end) invalid();
  const scale = v.getUint32(scaleOffset);
  const stbl = child(child(mdia, "minf"), "stbl"),
    stsd = child(stbl, "stsd");
  if (stsd.data + 8 > stsd.end || v.getUint32(stsd.data + 4) !== 1) invalid();
  const entry = boxes(stsd.data + 8, stsd.end)[0];
  if (
    !entry ||
    entry.type !== "mp4a" ||
    entry.start + 36 > entry.end ||
    v.getUint16(entry.start + 16) !== 0
  )
    invalid();
  const rate = v.getUint32(entry.start + 32) >>> 16;
  if (rate !== scale || rate < 8000 || rate > 96000) invalid();
  const esds = boxes(entry.start + 36, entry.end).find(
    (b) => b.type === "esds",
  );
  if (!esds) invalid();
  function descriptor(p: number, end: number) {
    if (p >= end) invalid();
    const tag = bytes[p++];
    let length = 0,
      n = 0,
      b;
    do {
      if (p >= end || ++n > 4) invalid();
      b = bytes[p++];
      length = length * 128 + (b & 127);
    } while (b & 128);
    if (p + length > end) invalid();
    return { tag, data: p, end: p + length };
  }
  const es = descriptor(esds.data + 4, esds.end);
  if (es.tag !== 3 || es.data + 3 > es.end) invalid();
  let p = es.data + 3;
  const flags = bytes[es.data + 2];
  if (flags & 128) p += 2;
  if (flags & 64) {
    if (p >= es.end) invalid();
    p += 1 + bytes[p];
  }
  if (flags & 32) p += 2;
  const config = descriptor(p, es.end);
  if (
    config.tag !== 4 ||
    config.data + 13 > config.end ||
    bytes[config.data] !== 64
  )
    invalid();
  const asc = descriptor(config.data + 13, config.end);
  if (asc.tag !== 5 || asc.data + 2 > asc.end) invalid();
  const objectType = bytes[asc.data] >> 3,
    frequencyIndex = ((bytes[asc.data] & 7) << 1) | (bytes[asc.data + 1] >> 7);
  const rates = [
    96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025,
    8000, 7350,
  ];
  if (objectType !== 2 || rates[frequencyIndex] !== rate)
    throw new RouteError(
      422,
      "AUDIO_NORMALIZATION_REQUIRED",
      "Questo profilo AAC richiede una versione WAV. Riseleziona l’audio originale e prepara la versione compatibile; i risultati precedenti saranno sostituiti.",
    );
  const stts = child(stbl, "stts"),
    stsz = child(stbl, "stsz");
  if (stts.data + 8 > stts.end || stsz.data + 12 > stsz.end) invalid();
  const entries = v.getUint32(stts.data + 4),
    sampleCount = v.getUint32(stsz.data + 8);
  if (
    !entries ||
    entries > 100000 ||
    !sampleCount ||
    sampleCount > 100000 ||
    stts.data + 8 + entries * 8 !== stts.end
  )
    invalid();
  let samples = 0,
    ticks = 0;
  for (let i = 0; i < entries; i++) {
    const count = v.getUint32(stts.data + 8 + i * 8),
      delta = v.getUint32(stts.data + 12 + i * 8);
    if (!count || !delta || delta > 2048) invalid();
    samples += count;
    ticks += count * delta;
  }
  if (samples !== sampleCount) invalid();
  const fixed = v.getUint32(stsz.data + 4);
  let payload = fixed * sampleCount;
  if (!fixed) {
    if (stsz.data + 12 + sampleCount * 4 !== stsz.end) invalid();
    for (let i = 0; i < sampleCount; i++)
      payload += v.getUint32(stsz.data + 12 + i * 4);
  }
  if (payload <= 0 || payload > mdats.reduce((n, b) => n + b.end - b.data, 0))
    invalid();
  return Math.max(ticks, sampleCount * 1024) / rate;
}
export async function validateAudioBytes(
  bytes: Uint8Array,
  signal: AbortSignal,
) {
  if (!bytes.length || bytes.length > AUDIO_LIMITS.maxChunkBytes)
    invalid("Il segmento supera il limite consentito o è vuoto.");
  const blob = new Blob([new Uint8Array(bytes)]);
  let duration: number, extension: string, mime: string;
  try {
    const wav = await inspectWav(blob);
    if (wav) {
      duration = wav.duration;
      extension = "wav";
      mime = "audio/wav";
    } else if (String.fromCharCode(...bytes.subarray(0, 4)) === "fLaC") {
      // STREAMINFO's declared total alone cannot establish the actual decoded
      // duration. New preparations normalize FLAC to PCM in the browser; old
      // cached FLAC chunks must take that same path before quota is reserved.
      throw new RouteError(422,"AUDIO_NORMALIZATION_REQUIRED","Questo segmento FLAC richiede una versione WAV verificabile. Riseleziona l’originale e prepara la versione compatibile.");
    } else if (String.fromCharCode(...bytes.subarray(4, 8)) === "ftyp") {
      duration = mp4Duration(bytes);
      extension = "m4a";
      mime = "audio/mp4";
    } else {
      const mp3 = await openMp3(blob, signal);
      duration = mp3.duration;
      extension = "mp3";
      mime = "audio/mpeg";
    }
  } catch (error) {
    if (error instanceof RouteError) throw error;
    invalid();
  }
  if (
    !Number.isFinite(duration) ||
    duration <= 0 ||
    duration > AUDIO_LIMITS.maxChunkDurationSeconds
  )
    invalid("Durata del segmento fuori dai limiti consentiti.");
  return {
    duration,
    extension,
    mime,
    reservedSeconds: Math.max(10, Math.ceil(duration + 1)),
  };
}
