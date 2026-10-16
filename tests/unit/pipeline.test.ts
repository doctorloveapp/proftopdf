import "fake-indexeddb/auto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { prepareAudio } from "../../src/lib/pipeline/prepare-audio";
import { wavHeader } from "../../src/lib/audio/wav";
import { exportAudioLog } from "../../src/lib/audio/diagnostics";
import { emptyProcessing } from "../../src/lib/shared/processing";
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

test("Real preparation path handles MP3 without Worker/window/FFmpeg and retains downloadable diagnostics on failure", async () => {
  assert.equal(typeof Worker, "undefined");
  assert.equal(typeof window, "undefined");
  const frame = new Uint8Array(417);
  frame.set([255, 251, 144, 192]);
  const file = new File(
    Array.from({ length: 9000 }, () => frame),
    "lecture-private-name.mp3",
    { type: "audio/mpeg" },
  );
  const local = initial(file);
  await saveJob(local);
  const controller = new AbortController();
  const paused = await prepareAudio(
    file,
    local,
    controller.signal,
    (entry, progress) => {
      if (progress.stage === "preparing" && entry.preparedChunkIds.length === 1)
        controller.abort("user-pause");
    },
  );
  assert.equal(paused.job.stage, "paused");
  const ready = await prepareAudio(
    file,
    paused,
    new AbortController().signal,
    () => {},
  );
  assert.equal(ready.job.stage, "ready");
  assert(ready.manifest.chunks.length > 1);
  const log = exportAudioLog(local.job.id);
  assert(log.includes("mp3-js"));
  assert(log.includes("chunk.restored"));
  assert(!log.includes("lecture-private-name"));
  assert(!log.includes("worker.load"));
  await removeJob(local.job.id);
  const broken = new File(["not an mp3"], "broken.mp3");
  const failed = initial(broken);
  await saveJob(failed);
  await assert.rejects(
    () => prepareAudio(broken, failed, new AbortController().signal, () => {}),
    /MP3_FRAME_INVALID/,
  );
  assert(exportAudioLog(failed.job.id).includes("preparation.failed"));
  const saved = (await listJobs()).find(
    (entry) => entry.job.id === failed.job.id,
  )!;
  assert.equal(saved.job.error?.code, "MP3_FRAME_INVALID");
  await removeJob(failed.job.id);
});
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
test("Requested PCM re-preparation cannot erase saved processing data when the original file hash differs", async (t) => {
  t.mock.method(console, "info", () => {});
  t.mock.method(console, "error", () => {});
  const format = {
    channels: 1,
    sampleRate: 16000,
    bits: 16,
    blockAlign: 2,
    byteRate: 32000,
  };
  const file = new File(
    [wavHeader(format, 32000), new Uint8Array(32000)],
    "source.wav",
  );
  const local = initial(file);
  await saveJob(local);
  const ready = await prepareAudio(
    file,
    local,
    new AbortController().signal,
    () => {},
  );
  ready.processing = emptyProcessing();
  ready.processing.markdownDraft = "saved private draft";
  await saveJob(ready);
  const wrong = new File(
    [wavHeader(format, 32000), new Uint8Array(32000).fill(1)],
    "source.wav",
  );
  await assert.rejects(() =>
    prepareAudio(
      wrong,
      ready,
      new AbortController().signal,
      () => {},
      () => {},
      true,
    ),
  );
  const preserved = (await listJobs()).find((j) => j.job.id === local.job.id)!;
  assert.equal(preserved.processing?.markdownDraft, "saved private draft");
  const normalized = await prepareAudio(
    file,
    preserved,
    new AbortController().signal,
    () => {},
    () => {},
    true,
  );
  assert.equal(normalized.job.stage, "ready");
  assert.equal(normalized.processing, undefined);
  await removeJob(local.job.id);
});
