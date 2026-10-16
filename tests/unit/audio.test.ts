import assert from "node:assert/strict";
import { test } from "node:test";
import {
  inspectWav,
  sliceWav,
  nextChunkStart,
  wavHeader,
} from "../../src/lib/audio/wav";
import { fingerprint } from "../../src/lib/audio/fingerprint";
import { AUDIO_LIMITS } from "../../src/lib/shared/constants";
import {
  exportCheckpoint,
  importCheckpoint,
} from "../../src/lib/storage/checkpoint";

test("WAV chunks contain standalone headers, respect size, and cover the source with overlap", async () => {
  const format = {
    channels: 1,
    sampleRate: 16_000,
    bits: 16,
    blockAlign: 2,
    byteRate: 32_000,
  };
  const bytes = 32_000 * 301;
  const source = new Blob([wavHeader(format, bytes), new Uint8Array(bytes)]);
  const info = await inspectWav(source);
  assert(info);
  let start = 0,
    previousEnd = 0,
    count = 0;
  while (true) {
    const chunk = sliceWav(source, info, start);
    const parsed = await inspectWav(chunk.blob);
    assert(parsed);
    assert(chunk.blob.size <= AUDIO_LIMITS.maxChunkBytes);
    assert(chunk.startSeconds <= previousEnd);
    assert(
      Math.abs(parsed.duration - (chunk.endSeconds - chunk.startSeconds)) <
        0.00001,
    );
    previousEnd = chunk.endSeconds;
    count++;
    const next = nextChunkStart(
      chunk.startSeconds,
      chunk.endSeconds,
      info.duration,
    );
    if (next === null) break;
    start = next;
  }
  assert(count > 1);
  assert.equal(previousEnd, 301);
});
test("Corrupt WAV and abort signals cannot be treated as successfully prepared audio", async () => {
  const format = {
    channels: 1,
    sampleRate: 16000,
    bits: 16,
    blockAlign: 2,
    byteRate: 32000,
  };
  await assert.rejects(() => inspectWav(new Blob([wavHeader(format, 10000)])));
  const aborter = new AbortController();
  aborter.abort();
  await assert.rejects(
    () => fingerprint(new Blob(["test"]), aborter.signal),
    (error: unknown) =>
      error instanceof DOMException && error.name === "AbortError",
  );
  assert.equal(
    await fingerprint(new Blob(["abc"]), new AbortController().signal),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});
test("Checkpoint import validates timelines and never claims to have restored audio blobs", () => {
  const checkpoint = {
    schema: "proftopdf/checkpoint/v1",
    title: "Lezione",
    subject: "",
    language: "it",
    source: {
      name: "lezione.wav",
      byteLength: 1000,
      durationSeconds: 10,
      sha256: "a".repeat(64),
      mimeType: "audio/wav",
    },
    chunks: [
      {
        id: "original:0",
        index: 0,
        startSeconds: 0,
        endSeconds: 10,
        overlapSeconds: 0,
        byteLength: 1000,
        sha256: "b".repeat(64),
        mimeType: "audio/wav",
        container: "wav",
        codec: "pcm_s16le",
      },
    ],
  };
  const imported = importCheckpoint(JSON.stringify(checkpoint));
  assert.equal(imported.job.stage, "paused");
  assert.deepEqual(imported.preparedChunkIds, []);
  assert.notEqual(imported.manifest.chunks[0].id, "original:0");
  assert.equal(
    JSON.parse(exportCheckpoint(imported)).source.sha256,
    checkpoint.source.sha256,
  );
  assert.throws(() =>
    importCheckpoint(JSON.stringify({ ...checkpoint, csrfToken: "forbidden" })),
  );
  assert.throws(() =>
    importCheckpoint(
      JSON.stringify({
        ...checkpoint,
        chunks: [{ ...checkpoint.chunks[0], startSeconds: 5 }],
      }),
    ),
  );
});
