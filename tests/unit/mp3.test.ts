import assert from "node:assert/strict";
import { test } from "node:test";
import { openMp3 } from "../../src/lib/audio/mp3";
import { nextChunkStart } from "../../src/lib/audio/wav";
import { AUDIO_LIMITS } from "../../src/lib/shared/constants";
import { AudioProcessingError } from "../../src/lib/audio/errors";

export function mp3Frames(
  count: number,
  version = 3,
  vbr = false,
  crc = false,
) {
  const frames: Uint8Array<ArrayBuffer>[] = [];
  for (let i = 0; i < count; i++) {
    const bitrate =
      version === 3 ? (vbr && i % 2 ? 320 : 128) : vbr && i % 2 ? 160 : 64;
    const index =
      version === 3 ? (bitrate === 320 ? 14 : 9) : bitrate === 160 ? 14 : 8;
    const rate = version === 3 ? 44100 : version === 2 ? 22050 : 11025;
    const bytes =
      Math.floor(((version === 3 ? 144000 : 72000) * bitrate) / rate) + (i % 2);
    const b = new Uint8Array(bytes);
    b.set([
      255,
      224 | (version << 3) | 2 | (crc ? 0 : 1),
      (index << 4) | ((i % 2) << 1),
      192,
    ]);
    // Dependency in frames after every 37th reset; arbitrary payload is not
    // decoded in unit tests, which exercise header indexing and boundaries.
    const side = crc ? 6 : 4;
    if (i % 37) b[side] = 40;
    frames.push(b);
  }
  return frames;
}
const signal = () => new AbortController().signal;

test("MP3 VBR chunks are frame aligned, have fresh duration metadata, bounded size and complete overlapping coverage", async () => {
  const frames = mp3Frames(12000, 3, true);
  const source = new Blob(frames);
  const reader = await openMp3(source, signal());
  assert.equal(reader.duration, (12000 * 1152) / 44100);
  let start = 0,
    previous = 0,
    chunks = 0;
  while (true) {
    const part = reader.chunk(start);
    assert(part.blob.size <= AUDIO_LIMITS.maxChunkBytes);
    assert(part.startSeconds <= previous);
    assert(part.endSeconds > previous);
    const parsed = await openMp3(part.blob, signal());
    assert(
      Math.abs(parsed.duration - (part.endSeconds - part.startSeconds)) < 1e-8,
    );
    previous = part.endSeconds;
    chunks++;
    const next = nextChunkStart(
      part.startSeconds,
      part.endSeconds,
      reader.duration,
    );
    if (next === null) break;
    start = next;
  }
  assert(chunks >= 3);
  assert.equal(previous, reader.duration);
});

test("MP3 scanner supports MPEG 2 / 2.5, CRC, skips large ID3 covers and tail tags without reading the whole file", async () => {
  for (const version of [2, 0]) {
    const size = 8_000_000;
    const tag = new Uint8Array(10);
    tag.set([
      73,
      68,
      51,
      4,
      0,
      0,
      (size >> 21) & 127,
      (size >> 14) & 127,
      (size >> 7) & 127,
      size & 127,
    ]);
    let readBytes = 0;
    class ProgressiveBlob extends Blob {
      override arrayBuffer(): Promise<ArrayBuffer> {
        throw new Error("Whole-file read forbidden");
      }
      override slice(start?: number, end?: number, type?: string) {
        const part = super.slice(start, end, type);
        assert(part.size <= 262144);
        readBytes += part.size;
        return part;
      }
    }
    const tail = new Uint8Array(128);
    tail.set([84, 65, 71]);
    const file = new ProgressiveBlob([
      tag,
      new Uint8Array(size),
      ...mp3Frames(500, version, true, true),
      tail,
    ]);
    const audio = await openMp3(file, signal());
    assert.equal(audio.duration, (500 * 576) / (version === 2 ? 22050 : 11025));
    assert(readBytes < 2_000_000);
  }
});

test("MP3 reports exact frame offsets for corruption and truncation; abort is honored", async () => {
  const frames = mp3Frames(100);
  const bytes = frames.reduce((sum, b) => sum + b.length, 0);
  await assert.rejects(
    () => openMp3(new Blob(frames).slice(0, bytes - 10), signal()),
    (e: unknown) =>
      e instanceof AudioProcessingError &&
      e.code === "MP3_FRAME_TRUNCATED" &&
      e.details.byteOffset === bytes - frames.at(-1)!.length,
  );
  frames[50][0] = 0;
  await assert.rejects(
    () => openMp3(new Blob(frames), signal()),
    (e: unknown) =>
      e instanceof AudioProcessingError && e.code === "MP3_FRAME_INVALID",
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => openMp3(new Blob(frames), controller.signal), {
    name: "AbortError",
  });
  const tag = new Uint8Array([73, 68, 51, 4, 0, 0, 127, 127, 127, 127]);
  await assert.rejects(
    () => openMp3(new Blob([tag]), signal()),
    (e: unknown) =>
      e instanceof AudioProcessingError && e.code === "MP3_ID3_TRUNCATED",
  );
});
