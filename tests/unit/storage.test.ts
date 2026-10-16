import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  acquireLease,
  releaseLease,
  renewLease,
  savePreparedChunk,
  removeJob,
  saveJob,
  getChunk,
  reconcileJob,
  listJobs,
  savePdfExport,
  saveJobWithLease,
  acquireStoredJob,
} from "../../src/lib/storage/jobs";
import { importCheckpoint } from "../../src/lib/storage/checkpoint";
import { emptyProcessing } from "../../src/lib/shared/processing";

function fixture() {
  return importCheckpoint(
    JSON.stringify({
      schema: "proftopdf/checkpoint/v1",
      title: "Test persistence",
      subject: "",
      language: "it",
      source: {
        name: "test.wav",
        byteLength: 1000,
        durationSeconds: 10,
        sha256: "a".repeat(64),
        mimeType: "audio/wav",
      },
      chunks: [
        {
          id: "source:0",
          index: 0,
          startSeconds: 0,
          endSeconds: 10,
          overlapSeconds: 0,
          byteLength: 1000,
          sha256: "b".repeat(64),
          mimeType: "audio/wav",
          codec: "pcm_s16le",
          container: "wav",
        },
      ],
    }),
  );
}
test("PDF generation history survives a stored-job reload, merges metadata and cannot resurrect a deleted lesson", async () => {
  const local = fixture();
  local.processing = emptyProcessing();
  const now = new Date().toISOString();
  local.processing.document = {
    version: 1,
    jobId: local.job.id,
    title: local.title,
    subject: "",
    language: "it",
    createdAt: now,
    updatedAt: now,
    sections: [],
    glossary: [],
    gaps: [],
    complete: true,
  };
  local.processing.markdownDraft = "Retain this draft";
  await saveJob(local);
  const stored = await acquireStoredJob(local.job.id);
  const receipt = {
    createdAt: now,
    documentUpdatedAt: now,
    byteLength: 1000,
    timingSummary: null,
  };
  await savePdfExport(local.job.id, receipt, stored.token);
  await releaseLease(local.job.id, stored.token);
  const reloaded = await acquireStoredJob(local.job.id);
  assert.deepEqual(reloaded.local.pdfExport, receipt);
  assert.equal(reloaded.local.pdfGenerationTracked, true);
  assert.equal(reloaded.local.processing?.markdownDraft, "Retain this draft");
  await assert.rejects(() =>
    savePdfExport(
      local.job.id,
      { ...receipt, documentUpdatedAt: "stale" },
      reloaded.token,
    ),
  );
  await removeJob(local.job.id, { interrupt: true });
  await assert.rejects(() =>
    savePdfExport(local.job.id, receipt, reloaded.token),
  );
  assert.equal(
    (await listJobs()).some((entry) => entry.job.id === local.job.id),
    false,
  );
});
test("Leases serialize tabs and prevent stale writes or deletion of an active job", async () => {
  const local = fixture();
  await saveJob(local);
  const results = await Promise.allSettled([
    acquireLease(local.job.id),
    acquireLease(local.job.id),
  ]);
  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    1,
  );
  const token = (
    results.find(
      (result) => result.status === "fulfilled",
    ) as PromiseFulfilledResult<string>
  ).value;
  await assert.rejects(() => removeJob(local.job.id));
  await assert.rejects(() =>
    savePreparedChunk(
      local,
      local.manifest.chunks[0],
      new Blob([new Uint8Array(1000)]),
      "stale-token",
    ),
  );
  await renewLease(local.job.id, token);
  await releaseLease(local.job.id, token);
  const next = await acquireLease(local.job.id);
  assert.notEqual(next, token);
  await assert.rejects(() => renewLease(local.job.id, token));
  await releaseLease(local.job.id, next);
  await removeJob(local.job.id);
});

test("Confirmed deletion revokes an active lease and neither stale checkpoints nor chunks resurrect the lesson", async () => {
  const local = fixture();
  await saveJob(local);
  const token = await acquireLease(local.job.id);
  await removeJob(local.job.id, { interrupt: true });
  await assert.rejects(() => saveJobWithLease(local, token));
  await assert.rejects(() =>
    savePreparedChunk(
      local,
      local.manifest.chunks[0],
      new Blob([new Uint8Array(1000)]),
      token,
    ),
  );
  await assert.rejects(() => acquireStoredJob(local.job.id));
  await releaseLease(local.job.id, token);
  assert.equal(
    (await listJobs()).some((entry) => entry.job.id === local.job.id),
    false,
  );
  assert.equal(await getChunk(local.job.id, 0), undefined);
});
test("Chunk and job checkpoint commit together; missing chunks are not reported ready", async () => {
  const local = fixture();
  await saveJob(local);
  assert.equal((await reconcileJob(local)).job.stage, "paused");
  const token = await acquireLease(local.job.id);
  local.preparedChunkIds = [local.manifest.chunks[0].id];
  await savePreparedChunk(
    local,
    local.manifest.chunks[0],
    new Blob([new Uint8Array(1000)]),
    token,
  );
  await releaseLease(local.job.id, token);
  assert.equal((await getChunk(local.job.id, 0))?.blob.size, 1000);
  assert.equal((await reconcileJob(local)).job.stage, "ready");
  assert((await listJobs()).some((saved) => saved.job.id === local.job.id));
  await removeJob(local.job.id);
  assert.equal(await getChunk(local.job.id, 0), undefined);
});
