import "fake-indexeddb/auto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { prepareAudio } from "../../src/lib/pipeline/prepare-audio";
import { wavHeader } from "../../src/lib/audio/wav";
import { exportAudioLog } from "../../src/lib/audio/diagnostics";
import { emptyProcessing } from "../../src/lib/shared/processing";
import {
  orderAudioFiles,
  timelineFingerprint,
  virtualTimeline,
} from "../../src/lib/audio/timeline";
import {
  exportCheckpoint,
  importCheckpoint,
} from "../../src/lib/storage/checkpoint";
import { mergeTranscripts } from "../../src/lib/transcription/merge";
import { readAudioDuration } from "../../src/lib/audio/duration";

test("Multiple audio sorts by modification date first, then natural numeric filename with stable ties", () => {
  const file = (name: string, lastModified: number) =>
    new File(["audio"], name, { lastModified });
  const first = file("z.mp3", 1000),
    two = file("parte2.mp3", 2000),
    ten = file("parte10.mp3", 2000);
  const input = [ten, two, first];
  assert.deepEqual(orderAudioFiles(input), [first, two, ten]);
  assert.deepEqual(input, [ten, two, first]);
  assert.deepEqual(orderAudioFiles([two, two]), [two, two]);
});
test("Virtual timeline has cumulative offsets and an ordered content fingerprint; legacy one-file identity is unchanged", () => {
  const parts = [12.5, 20.25, 8].map((durationSeconds, index) => ({
    name: `p${index}.wav`,
    durationSeconds,
    byteLength: 1000,
    sha256: String(index).repeat(64),
    mimeType: "audio/wav",
    lastModified: 1000,
  }));
  assert.deepEqual(
    virtualTimeline(parts).map((p) => p.startSeconds),
    [0, 12.5, 32.75],
  );
  assert.equal(timelineFingerprint(parts.slice(0, 1)), parts[0].sha256);
  assert.notEqual(
    timelineFingerprint(parts),
    timelineFingerprint([...parts].reverse()),
  );
  assert.throws(
    () => virtualTimeline([{ ...parts[0], durationSeconds: 7201 }]),
    /120 minuti/,
  );
  assert.throws(() => virtualTimeline([{ ...parts[0], durationSeconds: NaN }]));
});

test("Multi-WAV preparation pauses/resumes at the part boundary, preserves global chunks/checkpoints and repeated speech across parts", async () => {
  const format = {
    channels: 1,
    sampleRate: 16000,
    bits: 16,
    blockAlign: 2,
    byteRate: 32000,
  };
  const make = (seconds: number, index: number) =>
    new File(
      [
        wavHeader(format, 32000 * seconds),
        new Uint8Array(32000 * seconds).fill(index),
      ],
      `p${index}.wav`,
      { type: "audio/wav", lastModified: index * 1000 },
    );
  const files = [make(205, 1), make(90, 2)];
  for (const file of files)
    Object.defineProperty(file, "arrayBuffer", {
      value: () => {
        throw new Error("Never read a whole original into RAM");
      },
    });
  assert.equal(
    await readAudioDuration(files[1], new AbortController().signal),
    90,
  );
  const local = initial(files[0]);
  await saveJob(local);
  const aborter = new AbortController();
  const paused = await prepareAudio(
    files,
    local,
    aborter.signal,
    (entry, progress) => {
      if (
        progress.stage === "preparing" &&
        entry.manifest.chunks.at(-1)?.endSeconds === 205
      )
        aborter.abort("user-pause");
    },
    () => {},
  );
  assert.equal(paused.job.stage, "paused");
  assert.equal(paused.manifest.source.durationSeconds, 295);
  assert.equal(paused.manifest.sources?.length, 2);
  assert(
    paused.manifest.chunks.at(-1)!.endSeconds <
      paused.manifest.source.durationSeconds,
  );
  const before = (await getChunk(local.job.id, 0))!.metadata.sha256;
  await assert.rejects(
    () =>
      prepareAudio(
        [...files].reverse(),
        paused,
        new AbortController().signal,
        () => {},
        () => {},
        true,
      ),
    /non corrisponde/,
  );
  const ready = await prepareAudio(
    files,
    paused,
    new AbortController().signal,
    () => {},
    () => {},
  );
  assert.equal(ready.job.stage, "ready");
  assert.equal((await getChunk(local.job.id, 0))!.metadata.sha256, before);
  const second = ready.manifest.chunks.find((c) => c.sourcePartIndex === 1)!;
  assert.equal(second.startSeconds, 205);
  assert.equal(second.endSeconds, 295);
  assert.equal(second.overlapSeconds, 0);
  assert(
    ready.manifest.chunks.every(
      (c, i) => c.index === i && c.byteLength <= 3200000,
    ),
  );
  const imported = importCheckpoint(exportCheckpoint(ready));
  assert.deepEqual(imported.manifest.sources, ready.manifest.sources);
  assert.equal(imported.job.sourceFingerprint, ready.job.sourceFingerprint);
  const corrupt = JSON.parse(exportCheckpoint(ready));
  corrupt.sources[1].startSeconds++;
  assert.throws(() => importCheckpoint(JSON.stringify(corrupt)), /timeline/);
  const previous = ready.manifest.chunks[second.index - 1];
  const text = "La velocita cambia nel tempo";
  const transcripts = Object.fromEntries(
    [previous, second].map((chunk) => [
      chunk.id,
      {
        sha256: chunk.sha256,
        status: "confirmed",
        segments: [
          {
            start:
              chunk === previous
                ? chunk.endSeconds - chunk.startSeconds - 1
                : 0,
            end: chunk === previous ? chunk.endSeconds - chunk.startSeconds : 1,
            text,
            uncertain: false,
          },
        ],
      },
    ]),
  );
  const result = mergeTranscripts(
    { ...ready.manifest, chunks: [previous, second] },
    transcripts as never,
  );
  assert.deepEqual(
    result.map((s) => s.text),
    [text, text],
  );
  assert.equal(result[1].startSeconds, 205);
  await removeJob(local.job.id);
});
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
