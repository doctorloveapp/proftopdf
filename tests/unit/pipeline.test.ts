import "fake-indexeddb/auto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { prepareAudio } from "../../src/lib/pipeline/prepare-audio";
import { wavHeader } from "../../src/lib/audio/wav";
import {
  getChunk,
  listJobs,
  removeJob,
  saveJob,
  type LocalJob,
} from "../../src/lib/storage/jobs";

function initial(file: File): LocalJob {
  const id = crypto.randomUUID(),
    now = new Date().toISOString();
  return {
    title: "Test pipeline",
    subject: "",
    preparedChunkIds: [],
    manifest: {
      version: 1,
      jobId: id,
      language: "it",
      source: {
        name: file.name,
        byteLength: file.size,
        durationSeconds: 0,
        sha256: "",
        mimeType: file.type,
      },
      chunks: [],
    },
    job: {
      version: 1,
      id,
      stage: "selected",
      createdAt: now,
      updatedAt: now,
      sourceFingerprint: "",
      completedChunkIds: [],
      completedNotesUnitIds: [],
      retryAt: null,
      error: null,
    },
  };
}
test("Real WAV preparation resumes from a committed chunk after an interruption", async () => {
  const format = {
    channels: 1,
    sampleRate: 16000,
    bits: 16,
    blockAlign: 2,
    byteRate: 32000,
  };
  const bytes = 32000 * 205;
  const file = new File(
    [wavHeader(format, bytes), new Uint8Array(bytes)],
    "recording.wav",
    { type: "audio/wav" },
  );
  const local = initial(file);
  await saveJob(local);
  const aborter = new AbortController();
  const paused = await prepareAudio(
    file,
    local,
    aborter.signal,
    (checkpoint, progress) => {
      if (
        progress.stage === "preparing" &&
        checkpoint.preparedChunkIds.length === 1
      )
        aborter.abort();
    },
  );
  assert.equal(paused.job.stage, "paused");
  assert.equal(paused.preparedChunkIds.length, 1);
  const hash = (await getChunk(local.job.id, 0))!.metadata.sha256;
  const restored = (await listJobs()).find(
    (job) => job.job.id === local.job.id,
  )!;
  const ready = await prepareAudio(
    file,
    restored,
    new AbortController().signal,
    () => {},
  );
  assert.equal(ready.job.stage, "ready");
  assert.equal(ready.preparedChunkIds.length, ready.manifest.chunks.length);
  assert.equal(ready.manifest.chunks.at(-1)!.endSeconds, 205);
  assert.equal((await getChunk(local.job.id, 0))!.metadata.sha256, hash);
  await removeJob(local.job.id);
});
test("Cancellation is persisted and a different source cannot replace a saved lecture", async () => {
  const format = {
    channels: 1,
    sampleRate: 16000,
    bits: 16,
    blockAlign: 2,
    byteRate: 32000,
  };
  const file = new File(
    [wavHeader(format, 32000), new Uint8Array(32000)],
    "short.wav",
  );
  const local = initial(file);
  await saveJob(local);
  const controller = new AbortController();
  controller.abort("cancelled");
  const cancelled = await prepareAudio(
    file,
    local,
    controller.signal,
    () => {},
  );
  assert.equal(cancelled.job.stage, "cancelled");
  const ready = await prepareAudio(
    file,
    cancelled,
    new AbortController().signal,
    () => {},
  );
  const changed = new File(
    [wavHeader(format, 32000), new Uint8Array(32000).fill(1)],
    "short.wav",
  );
  await assert.rejects(
    () => prepareAudio(changed, ready, new AbortController().signal, () => {}),
    /non corrisponde/,
  );
  await removeJob(local.job.id);
});
