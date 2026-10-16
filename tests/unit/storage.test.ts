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
} from "../../src/lib/storage/jobs";
import { importCheckpoint } from "../../src/lib/storage/checkpoint";

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
