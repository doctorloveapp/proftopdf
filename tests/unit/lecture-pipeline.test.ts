import "fake-indexeddb/auto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { prepareAudio } from "../../src/lib/pipeline/prepare-audio";
import {
  processLecture,
  type ProcessingAdapter,
} from "../../src/lib/pipeline/process-lecture";
import { ClientApiError } from "../../src/lib/client/api";
import {
  saveJob,
  listJobs,
  removeJob,
  type LocalJob,
} from "../../src/lib/storage/jobs";
import { wavHeader } from "../../src/lib/audio/wav";
import {
  emptyProcessing,
  type NotesOutput,
} from "../../src/lib/shared/processing";
function initial(file: File): LocalJob {
  const id = crypto.randomUUID(),
    now = new Date().toISOString();
  return {
    title: "Test sintetico",
    subject: "Fisica",
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

test("Deleting during an in-flight transcription never restores the job or starts notes from a late response", async (t) => {
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
    [wavHeader(format, 32000 * 10), new Uint8Array(32000 * 10)],
    "pending.wav",
  );
  const local = initial(file);
  await saveJob(local);
  const ready = await prepareAudio(
    file,
    local,
    new AbortController().signal,
    () => {},
  );
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((done) => {
    entered = done;
  });
  const barrier = new Promise<void>((done) => {
    release = done;
  });
  let noteCalls = 0;
  const adapter: ProcessingAdapter = {
    transcribe: async (_blob, chunk) => {
      entered();
      await barrier;
      return {
        sha256: chunk.sha256,
        model: "mock",
        durationSeconds: 10,
        status: "transcribed",
        segments: [
          { start: 0, end: 10, text: "Late result", uncertain: false },
        ],
      };
    },
    notes: async () => {
      noteCalls++;
      throw new Error("Unexpected notes after deletion");
    },
    wait: async () => {},
  };
  const aborter = new AbortController();
  const pending = processLecture(
    ready,
    "synthetic",
    aborter.signal,
    () => {},
    {},
    adapter,
  );
  await started;
  await removeJob(local.job.id, { interrupt: true });
  aborter.abort("deleted");
  release();
  await pending;
  assert.equal(
    (await listJobs()).some((entry) => entry.job.id === local.job.id),
    false,
  );
  assert.equal(noteCalls, 0);
});
test("End-to-end local orchestration pauses, resumes, waits for quota, saves notes/outline and does not resend confirmed audio", async (t) => {
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
    "synthetic.wav",
  );
  const local = initial(file);
  await saveJob(local);
  const ready = await prepareAudio(
    file,
    local,
    new AbortController().signal,
    () => {},
  );
  let calls = 0,
    waits = 0,
    notes = 0,
    deny = true;
  const adapter: ProcessingAdapter = {
    transcribe: async (_blob, chunk) => {
      calls++;
      if (deny) {
        deny = false;
        throw new ClientApiError(
          "Quota",
          429,
          new Date(Date.now() + 100).toISOString(),
          "QUOTA_EXHAUSTED",
        );
      }
      return {
        sha256: chunk.sha256,
        model: "mock",
        durationSeconds: chunk.endSeconds - chunk.startSeconds,
        status: "transcribed",
        segments: [
          {
            start: 0,
            end: chunk.endSeconds - chunk.startSeconds,
            text: "La conservazione dell’energia lega il lavoro alle trasformazioni del sistema. ".repeat(
              12,
            ),
            uncertain: false,
          },
        ],
      };
    },
    notes: async (input) => {
      notes++;
      return input.mode === "outline"
        ? {
            chapters: [
              {
                title: "Energia e lavoro",
                sectionIds: input.sources.map((s) => s.id),
              },
            ],
          }
        : ({
            sections: [
              {
                title: "Conservazione",
                paragraphs: ["L’energia si conserva."],
                bullets: ["Il lavoro trasferisce energia."],
                concepts: ["**Energia**"],
                sourceIds: input.sources.map((s) => s.id),
              },
            ],
            glossary: [
              {
                term: "Energia",
                definition: "Grandezza fisica",
                sourceIds: input.sources.map((s) => s.id),
              },
            ],
            uncertainties: [],
            coveredSourceIds: input.sources.map((s) => s.id),
          } as NotesOutput);
    },
    wait: async () => {
      waits++;
    },
  };
  const controller = new AbortController();
  const paused = await processLecture(
    ready,
    "synthetic-csrf",
    controller.signal,
    (entry) => {
      if (entry.job.completedChunkIds.length === 1)
        controller.abort("user-pause");
    },
    {},
    adapter,
  );
  assert.equal(paused.job.stage, "paused");
  assert.equal(waits, 1);
  assert.equal(paused.job.completedChunkIds.length, 1);
  const resumed = await processLecture(
    paused,
    "synthetic-csrf",
    new AbortController().signal,
    () => {},
    {},
    adapter,
  );
  assert.equal(resumed.job.stage, "completed");
  assert.equal(resumed.processing?.document?.complete, true);
  assert.equal(calls, ready.manifest.chunks.length + 1);
  assert(notes > 1);
  assert.equal(resumed.processing?.document?.glossary.length, 1);
  assert(
    resumed.processing?.document?.sections.every((section) =>
      section.sourceSegmentIds.every((id) => !id.match(/p\d+$/)),
    ),
  );
  const before = calls;
  const restored = (await listJobs()).find((j) => j.job.id === local.job.id)!;
  const replay = await processLecture(
    ready,
    "synthetic-csrf",
    new AbortController().signal,
    () => {},
    {},
    adapter,
  );
  assert.equal(replay.job.stage, "completed");
  assert.equal(calls, before);
  await removeJob(local.job.id);
});
test("Missing local audio is persisted as an explicit failure and never sent to AI", async (t) => {
  t.mock.method(console, "info", () => {});
  t.mock.method(console, "error", () => {});
  const local = initial(new File(["x"], "source.mp3"));
  local.processing = emptyProcessing();
  local.job.sourceFingerprint = "a".repeat(64);
  local.manifest.source.durationSeconds = 10;
  local.manifest.chunks = [
    {
      id: `${local.job.id}:0`,
      index: 0,
      startSeconds: 0,
      endSeconds: 10,
      overlapSeconds: 0,
      byteLength: 100,
      sha256: "a".repeat(64),
      mimeType: "audio/mpeg",
      container: "mp3",
      codec: "mp3",
    },
  ];
  await saveJob(local);
  let calls = 0;
  const adapter: ProcessingAdapter = {
    transcribe: async () => {
      calls++;
      throw new Error();
    },
    notes: async () => {
      throw new Error();
    },
    wait: async () => {},
  };
  await assert.rejects(
    () =>
      processLecture(
        local,
        "synthetic",
        new AbortController().signal,
        () => {},
        {},
        adapter,
      ),
    (e: unknown) =>
      e instanceof ClientApiError && e.code === "LOCAL_AUDIO_MISSING",
  );
  const saved = (await listJobs()).find((j) => j.job.id === local.job.id)!;
  assert.equal(saved.job.error?.code, "LOCAL_AUDIO_MISSING");
  assert.equal(calls, 0);
  await removeJob(local.job.id);
});
test("Explicitly skipped audio stays visible as a gap and targeted recovery rebuilds complete notes", async (t) => {
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
    [wavHeader(format, 32000 * 110), new Uint8Array(32000 * 110)],
    "recovery.wav",
  );
  const local = initial(file);
  await saveJob(local);
  const prepared = await prepareAudio(
    file,
    local,
    new AbortController().signal,
    () => {},
  );
  let rejectSecond = true,
    recoveredAccurately = false;
  const adapter: ProcessingAdapter = {
    transcribe: async (_blob, chunk, _local, attempt, accurate) => {
      if (chunk.index === 1 && rejectSecond)
        throw new ClientApiError(
          "Bad audio",
          422,
          null,
          "PROVIDER_INPUT_REJECTED",
        );
      if (chunk.index === 1) {
        recoveredAccurately = accurate && attempt === 1;
      }
      return {
        sha256: chunk.sha256,
        model: "mock",
        status: "transcribed",
        durationSeconds: chunk.endSeconds - chunk.startSeconds,
        segments: [
          {
            start: 0,
            end: 10,
            text: `Concetto ${chunk.index}: la ricerca si fonda su fonti e verifiche.`,
            uncertain: false,
          },
        ],
      };
    },
    notes: async (input) =>
      input.mode === "outline"
        ? {
            chapters: [
              { title: "Metodo", sectionIds: input.sources.map((s) => s.id) },
            ],
          }
        : {
            sections: [
              {
                title: "Fonti",
                paragraphs: ["Le fonti sostengono la ricerca."],
                bullets: [],
                concepts: [],
                sourceIds: input.sources.map((s) => s.id),
              },
            ],
            glossary: [],
            uncertainties: [],
            coveredSourceIds: input.sources.map((s) => s.id),
          },
    wait: async () => {},
  };
  await assert.rejects(() =>
    processLecture(
      prepared,
      "synthetic",
      new AbortController().signal,
      () => {},
      {},
      adapter,
    ),
  );
  const failed = (await listJobs()).find((j) => j.job.id === local.job.id)!;
  assert.equal(failed.processing?.failedChunkIndex, 1);
  const partial = await processLecture(
    failed,
    "synthetic",
    new AbortController().signal,
    () => {},
    { skipFailed: true },
    adapter,
  );
  assert.equal(partial.processing?.document?.complete, false);
  assert(
    partial.processing?.document?.gaps.some(
      (g) => g.reason === "Segmento non trascritto",
    ),
  );
  rejectSecond = false;
  const complete = await processLecture(
    partial,
    "synthetic",
    new AbortController().signal,
    () => {},
    { recoverIndex: 1, accurate: true },
    adapter,
  );
  assert.equal(complete.processing?.document?.complete, true);
  assert(recoveredAccurately);
  await removeJob(local.job.id);
});
