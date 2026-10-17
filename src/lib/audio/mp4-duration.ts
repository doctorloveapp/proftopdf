import { abortIfNeeded } from "./fingerprint";
import { AudioProcessingError } from "./errors";

interface Box {
  type: string;
  data: number;
  end: number;
}
interface Track {
  handler?: string;
  seconds?: number;
}
const invalid = () =>
  new AudioProcessingError(
    "AUDIO_METADATA_INVALID",
    "metadata",
    "I metadati della registrazione non sono leggibili.",
  );
const limited = () =>
  new AudioProcessingError(
    "AUDIO_METADATA_LIMIT",
    "metadata",
    "La lettura dei metadati ha raggiunto il limite previsto.",
  );
const fourCC = (view: DataView, offset: number) =>
  String.fromCharCode(
    ...new Uint8Array(view.buffer, view.byteOffset + offset, 4),
  );

/** ISO BMFF/M4A metadata only: skip mdat, read fixed-size headers even when
 * moov is at EOF. No decoder, full-file buffer, network or WASM is involved.
 * UI hints only; preparation/server still verify actual audio. */
export async function readMp4Duration(blob: Blob, signal: AbortSignal) {
  let bytesRead = 0,
    boxesRead = 0;
  const deadline = Date.now() + 10_000;
  async function read(start: number, count: number, end = blob.size) {
    abortIfNeeded(signal);
    if (Date.now() > deadline || bytesRead + count > 262_144) throw limited();
    if (start < 0 || count < 0 || start + count > end) throw invalid();
    const buffer = await blob.slice(start, start + count).arrayBuffer();
    abortIfNeeded(signal);
    if (buffer.byteLength !== count) throw invalid();
    bytesRead += count;
    return new DataView(buffer);
  }
  async function* boxes(start: number, end: number): AsyncGenerator<Box> {
    for (let offset = start; offset < end;) {
      if (++boxesRead > 4096) throw limited();
      const header = await read(offset, 8, end);
      const type = fourCC(header, 4);
      let size = header.getUint32(0),
        headerSize = 8;
      if (size === 1) {
        const wide = (await read(offset + 8, 8, end)).getBigUint64(0);
        if (wide > BigInt(Number.MAX_SAFE_INTEGER)) throw invalid();
        size = Number(wide);
        headerSize = 16;
      } else if (size === 0) size = end - offset;
      if (size < headerSize || size > end - offset) throw invalid();
      yield { type, data: offset + headerSize, end: offset + size };
      offset += size;
    }
  }
  async function duration(box: Box) {
    const version = (await read(box.data, 1, box.end)).getUint8(0);
    if (version !== 0 && version !== 1) return undefined;
    const data = await read(box.data, version ? 32 : 20, box.end);
    const timescale = data.getUint32(version ? 20 : 12);
    const ticks = version ? data.getBigUint64(24) : BigInt(data.getUint32(16));
    if (
      !timescale ||
      !ticks ||
      ticks === (version ? 0xffffffffffffffffn : 0xffffffffn) ||
      ticks > BigInt(Number.MAX_SAFE_INTEGER)
    )
      return undefined;
    return Number(ticks) / timescale;
  }
  if (blob.size < 8) return null;
  let movieSeconds: number | undefined;
  const tracks: Track[] = [];
  for await (const top of boxes(0, blob.size)) {
    if (top.type !== "moov") continue;
    for await (const box of boxes(top.data, top.end)) {
      if (box.type === "mvhd") movieSeconds = await duration(box);
      if (box.type !== "trak") continue;
      const track: Track = {};
      tracks.push(track);
      for await (const child of boxes(box.data, box.end)) {
        if (child.type !== "mdia") continue;
        for await (const media of boxes(child.data, child.end)) {
          if (media.type === "mdhd") track.seconds = await duration(media);
          if (media.type === "hdlr")
            track.handler = fourCC(await read(media.data, 12, media.end), 8);
        }
      }
    }
  }
  const audio = tracks.filter((track) => track.handler === "soun");
  if (!audio.length) return null;
  // Movie duration includes the encoder-delay edit used by ordinary M4A.
  // With video present, use audio length instead of a potentially longer video.
  const seconds =
    tracks.length === audio.length && movieSeconds
      ? movieSeconds
      : Math.max(0, ...audio.map((track) => track.seconds ?? 0));
  return seconds > 0 && Number.isFinite(seconds)
    ? { seconds, bytesRead, boxesRead }
    : null;
}
