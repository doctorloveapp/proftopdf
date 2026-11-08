import type { LocalJob } from "@/lib/storage/jobs";

/** No provider call should be made for a known broken legacy AAC tail. */
export function audioRepairFrom(local: LocalJob): number | undefined {
  if (local.audioRepair) return local.audioRepair.fromIndex;
  if (local.audioRepairRequestedFrom !== undefined)
    return local.audioRepairRequestedFrom;
  const suspect = local.manifest.chunks.find((c) => {
    const partDuration =
      local.manifest.sources?.[c.sourcePartIndex ?? 0]?.durationSeconds ??
      local.manifest.source.durationSeconds;
    return (
      c.codec === "aac" &&
      c.endSeconds - c.startSeconds < 0.25 &&
      (c.overlapSeconds > 0 || partDuration > 0.25)
    );
  })?.index;
  const timingError = [
    "TRANSCRIPTION_TIMESTAMPS",
    "TRANSCRIPTION_DURATION",
    "AUDIO_RESEGMENT_REQUIRED",
  ].includes(local.job.error?.code ?? "");
  const failed = local.processing?.failedChunkIndex;
  if (suspect !== undefined)
    return failed === undefined ? suspect : Math.min(suspect, failed);
  if (timingError) return failed ?? 0;
}

/** Call only AFTER all original fingerprints have been verified. */
export function beginAudioRepair(local: LocalJob, fromIndex: number) {
  if (local.audioRepair && fromIndex >= local.audioRepair.fromIndex) return;
  const sourcePartIndex =
    local.manifest.chunks[fromIndex]?.sourcePartIndex ?? 0;
  const generation =
    local.audioRepair?.generation ??
    1 + Math.max(0, ...local.manifest.chunks.map((c) => c.generation ?? 0));
  if (generation > 1000)
    throw new Error("Limite di ricostruzioni audio raggiunto.");
  local.audioRepair = { fromIndex, generation, sourcePartIndex };
  delete local.audioRepairRequestedFrom;
  local.manifest.chunks = local.manifest.chunks.slice(0, fromIndex);
  const keep = new Set(local.manifest.chunks.map((c) => c.id));
  local.preparedChunkIds = local.preparedChunkIds.filter((id) => keep.has(id));
  local.job.completedChunkIds = local.job.completedChunkIds.filter((id) =>
    keep.has(id),
  );
  local.job.completedNotesUnitIds = [];
  local.job.retryAt = null;
  local.pdfExport = undefined;
  const data = local.processing;
  if (data) {
    data.transcripts = Object.fromEntries(
      Object.entries(data.transcripts).filter(([id]) => keep.has(id)),
    );
    data.attempts = Object.fromEntries(
      Object.entries(data.attempts).filter(
        ([key]) => /^stt-\d+$/.test(key) && Number(key.slice(4)) < fromIndex,
      ),
    );
    data.accurateChunks = data.accurateChunks.filter(
      (index) => index < fromIndex,
    );
    data.notes = {};
    data.outlines = {};
    delete data.failedChunkIndex;
    delete data.failedUnitId;
    delete data.quotaBlockedUnitId;
    delete data.notesPlan;
    delete data.document;
    delete data.markdownDraft;
    // Keep usage identities: notes unit IDs hash their source content. A cache
    // replay of an identical unit must not be counted as a second paid call.
  }
}
