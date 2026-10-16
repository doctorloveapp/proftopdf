import { AUDIO_LIMITS } from "@/lib/shared/constants";

export interface PcmWav {
  dataOffset: number;
  dataBytes: number;
  channels: number;
  sampleRate: number;
  bits: number;
  blockAlign: number;
  byteRate: number;
  duration: number;
}
export async function inspectWav(blob: Blob): Promise<PcmWav | null> {
  const head = new DataView(await blob.slice(0, 12).arrayBuffer());
  const text = (view: DataView, start: number, count: number) =>
    String.fromCharCode(
      ...new Uint8Array(view.buffer, view.byteOffset + start, count),
    );
  if (
    head.byteLength < 12 ||
    text(head, 0, 4) !== "RIFF" ||
    text(head, 8, 4) !== "WAVE"
  )
    return null;
  let position = 12;
  let format: Omit<PcmWav, "dataOffset" | "dataBytes" | "duration"> | null =
    null;
  for (let n = 0; n < 512 && position + 8 <= blob.size; n++) {
    const chunk = new DataView(
      await blob.slice(position, position + 24).arrayBuffer(),
    );
    const size = chunk.getUint32(4, true);
    const name = text(chunk, 0, 4);
    if (position + 8 + size > blob.size)
      throw new Error("Il file WAV è incompleto o danneggiato.");
    if (name === "fmt ") {
      if (size < 16 || chunk.byteLength < 24 || chunk.getUint16(8, true) !== 1)
        return null;
      const channels = chunk.getUint16(10, true),
        sampleRate = chunk.getUint32(12, true),
        byteRate = chunk.getUint32(16, true),
        blockAlign = chunk.getUint16(20, true),
        bits = chunk.getUint16(22, true);
      if (
        ![8, 16, 24, 32].includes(bits) ||
        channels < 1 ||
        channels > 8 ||
        sampleRate < 8000 ||
        sampleRate > 192000 ||
        blockAlign !== (channels * bits) / 8 ||
        byteRate !== sampleRate * blockAlign
      )
        return null;
      format = { channels, sampleRate, bits, blockAlign, byteRate };
    }
    if (name === "data" && format) {
      const dataBytes = size - (size % format.blockAlign);
      if (!dataBytes) throw new Error("Il file non contiene audio.");
      return {
        ...format,
        dataOffset: position + 8,
        dataBytes,
        duration: dataBytes / format.byteRate,
      };
    }
    position += 8 + size + (size % 2);
  }
  return null;
}

export function wavHeader(
  info: Pick<
    PcmWav,
    "channels" | "sampleRate" | "bits" | "blockAlign" | "byteRate"
  >,
  dataBytes: number,
) {
  const buffer = new ArrayBuffer(44),
    view = new DataView(buffer);
  const put = (offset: number, value: string) =>
    [...value].forEach((letter, n) =>
      view.setUint8(offset + n, letter.charCodeAt(0)),
    );
  put(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  put(8, "WAVE");
  put(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, info.channels, true);
  view.setUint32(24, info.sampleRate, true);
  view.setUint32(28, info.byteRate, true);
  view.setUint16(32, info.blockAlign, true);
  view.setUint16(34, info.bits, true);
  put(36, "data");
  view.setUint32(40, dataBytes, true);
  return buffer;
}

export function sliceWav(source: Blob, info: PcmWav, startSeconds: number) {
  const startFrame = Math.floor(startSeconds * info.sampleRate);
  const maxFrames = Math.floor(
    (AUDIO_LIMITS.maxChunkBytes - 44) / info.blockAlign,
  );
  const frameCount = Math.min(
    maxFrames,
    Math.floor(180 * info.sampleRate),
    Math.floor(info.dataBytes / info.blockAlign) - startFrame,
  );
  if (frameCount <= 0) throw new Error("Intervallo audio non valido.");
  const dataBytes = frameCount * info.blockAlign;
  const offset = info.dataOffset + startFrame * info.blockAlign;
  return {
    blob: new Blob(
      [wavHeader(info, dataBytes), source.slice(offset, offset + dataBytes)],
      { type: "audio/wav" },
    ),
    startSeconds: startFrame / info.sampleRate,
    endSeconds: (startFrame + frameCount) / info.sampleRate,
    codec: info.bits === 8 ? "pcm_u8" : `pcm_s${info.bits}le`,
    container: "wav",
  };
}

export function nextChunkStart(start: number, end: number, duration: number) {
  if (end >= duration - 0.00001) return null;
  const next = Math.max(start + (end - start) / 2, end - 2);
  if (next <= start) throw new Error("La segmentazione non avanza.");
  return next;
}
