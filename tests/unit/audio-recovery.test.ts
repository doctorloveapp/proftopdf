import "fake-indexeddb/auto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { segmentEnd, segmentPlan } from "../../src/lib/audio/segment-policy";
import { nextChunkStart, wavHeader } from "../../src/lib/audio/wav";
import { normalizeTranscription } from "../../src/lib/transcription/normalize";
import { transcriptionUnit } from "../../src/lib/transcription/identity";
import { audioRepairFrom } from "../../src/lib/audio/recovery";
import { prepareAudio } from "../../src/lib/pipeline/prepare-audio";
import {
  processLecture,
  type ProcessingAdapter,
} from "../../src/lib/pipeline/process-lecture";
import {
  createAudioLog,
  exportAudioLog,
} from "../../src/lib/audio/diagnostics";
import {
  emptyProcessing,
  PROCESSING_REVISION,
} from "../../src/lib/shared/processing";
import {
  saveJob,
  listJobs,
  removeJob,
  type LocalJob,
} from "../../src/lib/storage/jobs";
import {
  exportCheckpoint,
  importCheckpoint,
} from "../../src/lib/storage/checkpoint";

test("AAC EOF closes once across frame/sample rounding, including the recorded 21ms tail geometry", () => {
  const duration = 818.581333;
  for (const actual of [0.021333, 0.016, 0.037333]) {
    const start = 818.565333;
    const plan = segmentPlan(start, duration, false, 128000);
    assert(plan.span < 1);
    assert.equal(plan.final, true);
    const end = segmentEnd(start, duration, plan.span, actual, plan.final);
    assert.equal(end, duration);
    assert.equal(nextChunkStart(start, end, duration), null);
  }
  for (const duration of [
    0.021333, 89.99999, 90, 90.02, 818.581333, 4252.42, 7200,
  ]) {
    let start = 0,
      count = 0;
    while (true) {
      const plan = segmentPlan(start, duration, false, 128000);
      assert(plan.span <= 90);
      const actual = Math.min(plan.span, duration - start);
      const end = segmentEnd(start, duration, plan.span, actual, plan.final);
      count++;
      const next = nextChunkStart(start, end, duration);
      if (next === null) break;
      assert(next > start);
      assert(count < 100);
      start = next;
    }
    assert(count <= Math.ceil(duration / 88) + 1);
  }
  assert.throws(
    () => segmentEnd(0, 818.58, 90, 0.021333, false),
    /AUDIO_SEGMENT_DURATION/,
  );
  assert.throws(
    () => segmentEnd(0, 90, 90, 80, true),
    /AUDIO_SEGMENT_DURATION/,
  );
  assert.throws(() => segmentPlan(10, 10, false, 1));
});

test("Malformed provider timing preserves all recognized text with honest whole-clip uncertainty", () => {
  for (const segments of [
    [{ start: 2, end: 1, text: "Primo" }],
    [{ start: -0.1, end: 1, text: "Primo" }],
    [{ start: 0, end: 14, text: "Primo" }],
    [
      { start: 5, end: 6, text: "Primo" },
      { start: 0, end: 1, text: "Secondo" },
    ],
    [{ start: 11, end: 11, text: "Primo" }],
  ]) {
    const result = normalizeTranscription(
      { text: "Primo Secondo", duration: 10, segments },
      10,
      "sha",
      "synthetic",
    );
    assert.equal(result.timing?.mode, "clip");
    assert(result.timing!.issueCount > 0);
    assert.deepEqual(result.segments, [
      { start: 0, end: 10, text: "Primo Secondo", uncertain: true },
    ]);
  }
  const joined = normalizeTranscription(
    {
      text: "",
      duration: 10,
      segments: [
        { start: 2, end: 1, text: "Primo" },
        { start: 3, end: 4, text: "Secondo" },
      ],
    },
    10,
    "sha",
    "synthetic",
  );
  assert.equal(joined.segments[0].text, "Primo Secondo");
  assert.throws(
    () =>
      normalizeTranscription({ text: "x", duration: 30 }, 10, "sha", "test"),
    /durata/,
  );
  assert.throws(() =>
    normalizeTranscription(
      {
        text: "x",
        duration: 10,
        segments: [{ start: NaN, end: 1, text: "x" }],
      },
      10,
      "sha",
      "test",
    ),
  );
  const clamped = normalizeTranscription(
    {
      text: "x",
      duration: 10.1,
      segments: [{ start: 0, end: 10.1, text: "x" }],
    },
    10,
    "sha",
    "test",
  );
  assert.equal(clamped.timing?.mode, "clamped");
  assert.equal(clamped.segments[0].end, 10);
  assert.equal(clamped.segments[0].uncertain, true);
});

test("Rebuilt chunks get distinct operations while unchanged legacy IDs remain stable", () => {
  const input = {
    index: 9,
    model: "whisper-large-v3-turbo",
    attempt: 0,
    languageMode: "it" as const,
    profile: "general",
  };
  const legacy = `${PROCESSING_REVISION}:9:whisper-large-v3-turbo:0`;
  assert.equal(transcriptionUnit(input), legacy);
  assert.equal(transcriptionUnit({ ...input, generation: 0 }), legacy);
  assert.equal(
    transcriptionUnit({ ...input, generation: 1 }),
    `${legacy}:audio-r1`,
  );
  assert.notEqual(
    transcriptionUnit({ ...input, generation: 1 }),
    transcriptionUnit({ ...input, generation: 2 }),
  );
});

function initial(file: File): LocalJob {
  const id = crypto.randomUUID(),
    now = new Date().toISOString();
  return {
    title: "Test",
    subject: "Fisica",
    preparedChunkIds: [],
    manifest: {
      version: 1,
      jobId: id,
      language: "auto",
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
      createdAt: now,
      updatedAt: now,
      stage: "selected",
      sourceFingerprint: "",
      completedChunkIds: [],
      completedNotesUnitIds: [],
      retryAt: null,
      error: null,
    },
  };
}

test("Legacy failure repairs only the suffix, survives wrong originals/pause/reload and preserves confirmed STT and costs", async (t) => {
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
    [wavHeader(format, 32000 * 205), new Uint8Array(32000 * 205)],
    "private-name.wav",
    { type: "audio/wav" },
  );
  const local = initial(file);
  await saveJob(local);
  const ready = await prepareAudio(
    file,
    local,
    new AbortController().signal,
    () => {},
  );
  const prefix = ready.manifest.chunks[0];
  ready.processing = emptyProcessing();
  ready.processing.transcripts[prefix.id] = {
    sha256: prefix.sha256,
    model: "saved",
    durationSeconds: prefix.endSeconds,
    status: "transcribed",
    segments: [
      {
        start: 0,
        end: prefix.endSeconds,
        text: "private transcript",
        uncertain: false,
      },
    ],
  };
  ready.job.completedChunkIds = [prefix.id];
  ready.processing.failedChunkIndex = 1;
  ready.processing.attempts["stt-1"] = 2;
  ready.processing.notesUsage = {
    "notes-old:a0": { reservedTokens: 10, confirmedTokens: 8, costMicroUsd: 2 },
  };
  ready.job.error = {
    code: "TRANSCRIPTION_TIMESTAMPS",
    message: "Legacy",
    recoverable: true,
    retryAt: null,
  };
  ready.job.stage = "failed";
  await saveJob(ready);
  assert.equal(audioRepairFrom(ready), 1);
  const calls: number[] = [];
  const adapter: ProcessingAdapter = {
    transcribe: async (_blob, chunk) => {
      calls.push(chunk.index);
      throw new Error("Must not call damaged audio");
    },
    notes: async () => {
      throw new Error("Must not call notes");
    },
    wait: async () => {},
  };
  await assert.rejects(
    () =>
      processLecture(
        ready,
        "test",
        new AbortController().signal,
        () => {},
        {},
        adapter,
      ),
    /ricostruzione/,
  );
  assert.deepEqual(calls, []);
  const wrong = new File(
    [wavHeader(format, 32000), new Uint8Array(32000)],
    "wrong.wav",
  );
  await assert.rejects(
    () => prepareAudio(wrong, ready, new AbortController().signal, () => {}),
    /non corrisponde/,
  );
  const saved = (await listJobs()).find((j) => j.job.id === local.job.id)!;
  assert.equal(saved.processing?.transcripts[prefix.id].model, "saved");
  assert.equal(saved.manifest.chunks.length, ready.manifest.chunks.length);
  assert.equal(audioRepairFrom(saved), 1);
  const aborter = new AbortController();
  const paused = await prepareAudio(
    file,
    saved,
    aborter.signal,
    (entry, progress) => {
      if (
        progress.stage === "preparing" &&
        entry.manifest.chunks.some((c) => c.generation === 1)
      )
        aborter.abort("user-pause");
    },
  );
  assert.equal(paused.job.stage, "paused");
  assert.equal(paused.audioRepair?.generation, 1);
  const done = await prepareAudio(
    file,
    paused,
    new AbortController().signal,
    () => {},
  );
  assert.equal(done.job.stage, "ready");
  assert.equal(done.audioRepair, undefined);
  assert.deepEqual(done.manifest.chunks[0], prefix);
  assert(done.manifest.chunks.slice(1).every((c) => c.generation === 1));
  assert.equal(done.processing?.transcripts[prefix.id].model, "saved");
  assert.equal(done.processing?.attempts["stt-1"], undefined);
  assert.equal(Object.values(done.processing!.notesUsage!)[0].costMicroUsd, 2);
  assert.deepEqual(
    importCheckpoint(exportCheckpoint(done)).manifest.chunks.map(
      (c) => c.generation,
    ),
    [undefined, 1, 1],
  );
  // Snapshot stays useful after the bounded event tail has rolled over.
  const log = createAudioLog(local.job.id);
  for (let i = 0; i < 210; i++) log("progress", { index: i });
  const report = JSON.parse(
    exportAudioLog(local.job.id, done.processing?.notesUsage, true, done),
  );
  assert.equal(report.audioSummary.chunks.length, done.manifest.chunks.length);
  assert.equal(report.audioSummary.chunks[1].generation, 1);
  assert(report.firstFailure && report.lastFailure);
  assert(!JSON.stringify(report).includes("private transcript"));
  assert(!JSON.stringify(report).includes("private-name"));
  const recovered: number[] = [];
  const completed = await processLecture(
    done,
    "test",
    new AbortController().signal,
    () => {},
    {},
    {
      wait: async () => {},
      transcribe: async (_blob, chunk, _local, attempt) => {
        recovered.push(chunk.index);
        assert.equal(chunk.generation, 1);
        assert.equal(attempt, 0);
        const duration = chunk.endSeconds - chunk.startSeconds;
        return normalizeTranscription(
          {
            text: "Contenuto conservato",
            duration,
            segments: [
              { start: 0, end: duration + 3, text: "Contenuto conservato" },
            ],
          },
          duration,
          chunk.sha256,
          "synthetic",
        );
      },
      notes: async (input) =>
        input.mode === "outline"
          ? {
              chapters: [
                {
                  title: "Capitolo",
                  sectionIds: input.sources.map((s) => s.id),
                },
              ],
            }
          : {
              sections: [
                {
                  title: "Appunti",
                  paragraphs: ["Contenuto della lezione."],
                  bullets: [],
                  concepts: [],
                  sourceIds: input.sources.map((s) => s.id),
                },
              ],
              glossary: [],
              uncertainties: input.sources
                .filter((s) => s.uncertain)
                .map((s) => ({
                  text: "Da verificare con la registrazione.",
                  sourceIds: [s.id],
                })),
              coveredSourceIds: input.sources.map((s) => s.id),
            },
    },
  );
  assert.equal(completed.job.stage, "completed");
  assert.equal(completed.processing?.document?.complete, true);
  assert.deepEqual(recovered, [1, 2]);
  assert.equal(completed.processing?.transcripts[prefix.id].model, "saved");
  assert(
    completed.processing!.document!.sections.some((s) =>
      s.blocks.some((b) => b.type === "uncertainty"),
    ),
  );
  // A rejected exhausted recovery must not erase the completed document.
  completed.processing!.attempts["stt-1"] = 2;
  await saveJob(completed);
  await assert.rejects(
    () =>
      processLecture(
        completed,
        "test",
        new AbortController().signal,
        () => {},
        { recoverIndex: 1, accurate: true },
        adapter,
      ),
    /tre tentativi/,
  );
  const intact = (await listJobs()).find((j) => j.job.id === local.job.id)!;
  assert.deepEqual(intact.processing?.document, completed.processing?.document);
  assert.deepEqual(
    intact.processing?.transcripts,
    completed.processing?.transcripts,
  );
  await removeJob(local.job.id);
});

test("A legacy overlapping AAC sliver is detected without mistaking a short independent recording for damage", () => {
  const local = initial(new File(["x"], "x.m4a"));
  const chunk = {
    id: "x",
    index: 13,
    startSeconds: 818.5440000000001,
    endSeconds: 818.5653330000001,
    overlapSeconds: 0.0106665,
    byteLength: 832,
    sha256: "a".repeat(64),
    codec: "aac",
    container: "m4a",
    mimeType: "audio/mp4",
  };
  local.manifest.chunks = [chunk];
  assert.equal(audioRepairFrom(local), 13);
  local.manifest.chunks = [
    { ...chunk, startSeconds: 0, endSeconds: 0.021333, overlapSeconds: 0 },
  ];
  assert.equal(audioRepairFrom(local), undefined);
  local.manifest.source.durationSeconds = 818.581333;
  assert.equal(audioRepairFrom(local), 13);
});

test("Repairing a later recording preserves the earlier MP3 parser, duration and global timeline", async (t) => {
  t.mock.method(console, "info", () => {});
  t.mock.method(console, "error", () => {});
  const frame = new Uint8Array(417);
  frame.set([255, 251, 144, 192]);
  const mp3 = new File(
    Array.from({ length: 900 }, () => frame),
    "part1.mp3",
    { type: "audio/mpeg" },
  );
  const format = {
    channels: 1,
    sampleRate: 16000,
    bits: 16,
    blockAlign: 2,
    byteRate: 32000,
  };
  const wav = new File(
    [wavHeader(format, 32000 * 205), new Uint8Array(32000 * 205)],
    "part2.wav",
  );
  const local = initial(mp3);
  await saveJob(local);
  const ready = await prepareAudio(
    [mp3, wav],
    local,
    new AbortController().signal,
    () => {},
  );
  const prefix = structuredClone(ready.manifest.chunks[0]);
  const sources = structuredClone(ready.manifest.sources);
  ready.processing = emptyProcessing();
  ready.processing.failedChunkIndex = 1;
  ready.job.error = {
    code: "TRANSCRIPTION_TIMESTAMPS",
    message: "Legacy",
    recoverable: true,
    retryAt: null,
  };
  await saveJob(ready);
  // No browser Worker exists in this integration. The earlier MP3 MUST stay
  // on its JS parser, even though the later recording is being normalized.
  const repaired = await prepareAudio(
    [mp3, wav],
    ready,
    new AbortController().signal,
    () => {},
  );
  assert.equal(repaired.job.stage, "ready");
  assert.deepEqual(repaired.manifest.sources, sources);
  assert.deepEqual(repaired.manifest.chunks[0], prefix);
  assert.equal(
    repaired.manifest.chunks[1].startSeconds,
    sources![1].startSeconds,
  );
  assert.equal(repaired.manifest.chunks[1].overlapSeconds, 0);
  assert(
    repaired.manifest.chunks
      .slice(1)
      .every((c) => c.generation === 1 && c.sourcePartIndex === 1),
  );
  await removeJob(local.job.id);
});
