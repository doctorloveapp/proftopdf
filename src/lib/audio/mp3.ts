import { AUDIO_LIMITS } from "@/lib/shared/constants";
import { abortIfNeeded } from "./fingerprint";
import { AudioProcessingError } from "./errors";
import type { AudioLog } from "./diagnostics";

// MPEG Layer III header fields and frame sizes (ISO MPEG Audio).
// Reference: FFmpeg libavcodec/mpegaudiodecheader.c; no decoder/PCM allocation.
const RATES = [44100, 48000, 32000];
const MPEG1 = [
  0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320,
];
const MPEG2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
interface Header {
  version: number;
  rate: number;
  samples: number;
  bytes: number;
  channels: number;
  sideBytes: number;
  crcBytes: number;
}
function header(b: Uint8Array, offset = 0): Header | null {
  if (
    b.length < offset + 4 ||
    b[offset] !== 255 ||
    (b[offset + 1] & 224) !== 224
  )
    return null;
  const version = (b[offset + 1] >> 3) & 3,
    layer = (b[offset + 1] >> 1) & 3;
  const bitrate = b[offset + 2] >> 4,
    rateIndex = (b[offset + 2] >> 2) & 3;
  if (
    version === 1 ||
    layer !== 1 ||
    bitrate === 0 ||
    bitrate === 15 ||
    rateIndex === 3 ||
    (b[offset + 3] & 3) === 2
  )
    return null;
  const rate = RATES[rateIndex] / (version === 3 ? 1 : version === 2 ? 2 : 4);
  const channels = b[offset + 3] >> 6 === 3 ? 1 : 2;
  const sideBytes =
    version === 3 ? (channels === 1 ? 17 : 32) : channels === 1 ? 9 : 17;
  const crcBytes = b[offset + 1] & 1 ? 0 : 2;
  const bytes =
    Math.floor(
      ((version === 3 ? 144000 : 72000) *
        (version === 3 ? MPEG1 : MPEG2)[bitrate]) /
        rate,
    ) +
    ((b[offset + 2] >> 1) & 1);
  if (bytes < 4 + crcBytes + sideBytes) return null;
  return {
    version,
    rate,
    channels,
    sideBytes,
    crcBytes,
    bytes,
    samples: version === 3 ? 1152 : 576,
  };
}
const same = (a: Header, b: Header) =>
  a.version === b.version && a.rate === b.rate && a.channels === b.channels;
const text = (b: Uint8Array, offset: number, count: number) =>
  String.fromCharCode(...b.subarray(offset, offset + count));
function invalid(code: string, message: string, offset: number) {
  return new AudioProcessingError(code, "mp3-scan", message, {
    byteOffset: offset,
  });
}

export async function openMp3(
  file: Blob,
  signal: AbortSignal,
  progress: (fraction: number) => void = () => {},
  log: AudioLog = () => {},
) {
  let buffer = new Uint8Array(0),
    base = -1,
    reads = 0,
    scanning = false,
    lastProgress = 0,
    loggedProgress = -1;
  async function read(offset: number, count: number) {
    abortIfNeeded(signal);
    if (offset < base || offset + count > base + buffer.length) {
      base = offset;
      buffer = new Uint8Array(
        await file
          .slice(offset, offset + Math.max(262144, count))
          .arrayBuffer(),
      );
      abortIfNeeded(signal);
      reads++;
      if (scanning) {
        lastProgress = Math.max(lastProgress, Math.min(1, offset / file.size));
        progress(lastProgress);
        const quarter = Math.floor(lastProgress * 4);
        if (quarter > loggedProgress) {
          loggedProgress = quarter;
          log("mp3.scan.progress", {
            byteOffset: offset,
            bytes: file.size,
            fraction: lastProgress,
          });
        }
      }
      // Yield for mobile UI, visibility changes and lease renewal.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    return buffer.subarray(offset - base, offset - base + count);
  }
  let position = 0,
    tags = 0;
  while (text(await read(position, 10), 0, 3) === "ID3") {
    const tag = await read(position, 10);
    if (
      ++tags > 32 ||
      tag.length !== 10 ||
      ![2, 3, 4].includes(tag[3]) ||
      tag.subarray(6, 10).some((b) => b & 128)
    )
      throw invalid(
        "MP3_ID3_INVALID",
        "Header ID3 dell’MP3 non valido.",
        position,
      );
    const bytes = tag[6] * 2097152 + tag[7] * 16384 + tag[8] * 128 + tag[9];
    position += 10 + bytes + (tag[3] === 4 && tag[5] & 16 ? 10 : 0);
    if (position > file.size)
      throw invalid(
        "MP3_ID3_TRUNCATED",
        "Il tag ID3 dichiara dati oltre la fine del file MP3.",
        position,
      );
  }
  let end = file.size;
  if (end >= 128 && text(await read(end - 128, 3), 0, 3) === "TAG") end -= 128;
  if (end >= 32) {
    const footer = await read(end - 32, 32);
    if (text(footer, 0, 8) === "APETAGEX") {
      const view = new DataView(
        footer.buffer,
        footer.byteOffset,
        footer.length,
      );
      const bytes = view.getUint32(12, true),
        flags = view.getUint32(20, true);
      if (bytes < 32 || bytes > end - position)
        throw invalid(
          "MP3_APE_INVALID",
          "Tag APE dell’MP3 non valido.",
          end - 32,
        );
      end -= bytes;
      if (flags & 0x80000000) end -= 32; // Optional APE header is excluded from tag size.
    }
  }
  // Validate consecutive frames rather than trusting a single sync byte inside tags/junk.
  let format: Header | null = null;
  const searchEnd = Math.min(end - 4, position + 65536);
  for (; position <= searchEnd; position++) {
    const b = await read(position, 4),
      candidate = header(b);
    if (!candidate) {
      if (b[0] === 255 && (b[1] & 230) === 226 && b[2] >> 4 === 0)
        throw invalid(
          "MP3_FREE_FORMAT",
          "Questo MP3 usa un bitrate free-format non supportato dal lettore leggero. Esporta la registrazione come MP3 standard o M4A.",
          position,
        );
      continue;
    }
    let next = position,
      valid = true;
    for (let n = 0; n < 3; n++) {
      const h = header(await read(next, 4));
      if (!h || !same(candidate, h) || next + h.bytes > end) {
        valid = false;
        break;
      }
      next += h.bytes;
    }
    if (valid) {
      format = candidate;
      break;
    }
  }
  if (!format)
    throw invalid(
      "MP3_FRAME_INVALID",
      "Non sono stati trovati frame MPEG Layer III validi. Il file potrebbe essere incompleto o avere un’estensione errata.",
      position,
    );
  const dt = format.samples / format.rate;
  scanning = true;
  const capacity = Math.ceil((AUDIO_LIMITS.maxDurationSeconds + 2) / dt);
  const offsets = new Uint32Array(capacity + 1),
    reservoir = new Uint16Array(capacity),
    payloads = new Uint16Array(capacity);
  let count = 0,
    skippedVbr = false;
  while (position < end) {
    const b = await read(position, 64),
      h = header(b);
    if (!h) {
      // Some recorders append a short run of zero padding; never silently skip
      // a damaged audio frame or arbitrary unrecognized data in the stream.
      if (
        end - position <= 4096 &&
        (await read(position, end - position)).every((x) => x === 0)
      )
        break;
      throw invalid(
        "MP3_FRAME_INVALID",
        "Frame MP3 non valido durante la scansione. Esporta il log per individuare la posizione.",
        position,
      );
    }
    if (!same(format, h))
      throw invalid(
        "MP3_FORMAT_CHANGE",
        "L’MP3 cambia frequenza o canali durante la registrazione. Converti il file in un formato uniforme.",
        position,
      );
    if (position + h.bytes > end)
      throw invalid(
        "MP3_FRAME_TRUNCATED",
        "L’ultimo frame MP3 è troncato: il file non è completo.",
        position,
      );
    const side = 4 + h.crcBytes;
    const marker = text(b, side + h.sideBytes, 4);
    if (
      !count &&
      !skippedVbr &&
      (["Xing", "Info"].includes(marker) ||
        ["Xing", "Info"].includes(text(b, 4 + h.sideBytes, 4)) ||
        text(b, 36, 4) === "VBRI")
    ) {
      // Whole-file duration/seek/gapless metadata must not leak into a chunk.
      skippedVbr = true;
      position += h.bytes;
      continue;
    }
    if (count >= capacity)
      throw invalid(
        "MP3_DURATION_LIMIT",
        "La registrazione supera il limite di 120 minuti.",
        position,
      );
    offsets[count] = position;
    reservoir[count] =
      h.version === 3 ? b[side] * 2 + (b[side + 1] >> 7) : b[side];
    payloads[count] = h.bytes - side - h.sideBytes;
    count++;
    position += h.bytes;
  }
  offsets[count] = position;
  if (!count)
    throw invalid(
      "MP3_EMPTY",
      "Il file MP3 non contiene frame audio.",
      position,
    );
  const duration = count * dt;
  log("mp3.scan.complete", {
    frames: count,
    durationSeconds: duration,
    sampleRate: format.rate,
    channels: format.channels,
    version: format.version,
    reads,
    id3Tags: tags,
    skippedVbr,
    indexBytes: offsets.byteLength + reservoir.byteLength + payloads.byteLength,
  });
  progress(1);
  const first = new Uint8Array(await read(offsets[0], 4));
  // A fresh Info frame gives each chunk an exact duration, including VBR,
  // without inheriting the original recording's Xing/LAME seek table.
  first[1] |= 1; // No CRC in the generated metadata frame.
  first[2] = (first[2] & 12) | ((format.version === 3 ? 9 : 8) << 4);
  const info = header(first)!;
  function chunk(requestedStart: number) {
    abortIfNeeded(signal);
    let start = Math.max(0, Math.floor(requestedStart / dt));
    if (start >= count)
      throw invalid("MP3_CHUNK_RANGE", "Intervallo MP3 non valido.", end);
    // MP3's bit reservoir may refer to up to 511/255 preceding main-data bytes.
    // Include bounded decoder preroll inside the existing overlap. Prefer a
    // reservoir reset when available, otherwise preserve enough preceding data
    // and two synthesis warm-up frames; never cut through a compressed frame.
    if (reservoir[start]) {
      let bytes = 0,
        warmup = 2;
      while (
        start > 0 &&
        (bytes < (format!.version === 3 ? 511 : 255) || warmup > 0)
      ) {
        start--;
        bytes += payloads[start];
        warmup--;
        if (!reservoir[start] && warmup <= 0) break;
      }
    }
    let stop = start;
    const maxFrames = Math.max(1, Math.floor(180 / dt));
    while (
      stop < count &&
      stop - start < maxFrames &&
      offsets[stop + 1] - offsets[start] + info.bytes <=
        AUDIO_LIMITS.maxChunkBytes
    )
      stop++;
    if (stop <= start || stop * dt <= requestedStart)
      throw invalid(
        "MP3_CHUNK_LIMIT",
        "Non è stato possibile creare un segmento MP3 entro i limiti.",
        offsets[start],
      );
    const metadata = new Uint8Array(info.bytes);
    metadata.set(first);
    const pos = 4 + info.sideBytes;
    metadata.set([73, 110, 102, 111], pos); // Info
    const view = new DataView(metadata.buffer);
    view.setUint32(pos + 4, 3); // Frame count and byte count, no stale TOC.
    view.setUint32(pos + 8, stop - start);
    view.setUint32(pos + 12, metadata.length + offsets[stop] - offsets[start]);
    return {
      blob: new Blob([metadata, file.slice(offsets[start], offsets[stop])], {
        type: "audio/mpeg",
      }),
      startSeconds: start * dt,
      endSeconds: stop * dt,
      codec: "mp3",
      container: "mp3",
    };
  }
  return {
    duration,
    estimatedBytes: Math.ceil(file.size * 1.1),
    chunk,
    close() {},
  };
}
