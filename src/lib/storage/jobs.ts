import { openDB, type DBSchema } from "idb";
import type {
  AudioManifest,
  AudioChunk,
  ProcessingJob,
} from "@/lib/shared/types";
import type { ProcessingData } from "@/lib/shared/processing";

export interface LocalJob {
  job: ProcessingJob;
  title: string;
  subject: string;
  manifest: AudioManifest;
  preparedChunkIds: string[];
  processing?: ProcessingData;
}
interface CachedChunk {
  key: string;
  jobId: string;
  metadata: AudioChunk;
  blob: Blob;
}
interface Lease {
  jobId: string;
  token: string;
  expiresAt: number;
}
interface StudioDB extends DBSchema {
  jobs: { key: string; value: LocalJob };
  chunks: { key: string; value: CachedChunk; indexes: { "by-job": string } };
  leases: { key: string; value: Lease };
}
let database: ReturnType<typeof openDB<StudioDB>> | undefined;
function db() {
  database ??= openDB<StudioDB>("proftopdf", 1, {
    upgrade(database) {
      database.createObjectStore("jobs", { keyPath: "job.id" });
      database
        .createObjectStore("chunks", { keyPath: "key" })
        .createIndex("by-job", "jobId");
      database.createObjectStore("leases", { keyPath: "jobId" });
    },
    blocking() {
      database?.then((connection) => connection.close());
      database = undefined;
    },
  });
  return database;
}
const chunkKey = (jobId: string, index: number) =>
  `${jobId}:${String(index).padStart(5, "0")}`;
export async function listJobs() {
  return (await (await db()).getAll("jobs")).sort((a, b) =>
    b.job.updatedAt.localeCompare(a.job.updatedAt),
  );
}
export async function saveJob(job: LocalJob) {
  await (await db()).put("jobs", job);
}
export async function saveJobWithLease(local: LocalJob, token: string) {
  const transaction = (await db()).transaction(["leases", "jobs"], "readwrite");
  const lease = await transaction.objectStore("leases").get(local.job.id);
  if (!lease || lease.token !== token || lease.expiresAt <= Date.now()) {
    transaction.abort();
    await transaction.done.catch(() => {});
    throw new Error(
      "Il lavoro è stato interrotto da un’altra scheda. Ricarica per riprendere.",
    );
  }
  await transaction.objectStore("jobs").put(local);
  await transaction.done;
}
export async function getChunk(jobId: string, index: number) {
  return (await db()).get("chunks", chunkKey(jobId, index));
}
export async function acquireLease(jobId: string) {
  const transaction = (await db()).transaction("leases", "readwrite");
  const existing = await transaction.store.get(jobId);
  if (existing && existing.expiresAt > Date.now()) {
    await transaction.done;
    throw new Error("Questa lezione è già in preparazione in un’altra scheda.");
  }
  const token = crypto.randomUUID();
  await transaction.store.put({ jobId, token, expiresAt: Date.now() + 30_000 });
  await transaction.done;
  return token;
}
export async function acquireStoredJob(jobId: string) {
  const token = await acquireLease(jobId);
  try {
    const local = await (await db()).get("jobs", jobId);
    if (!local)
      throw new Error(
        "Questa lezione non è più presente nell’archivio. Ricarica la pagina.",
      );
    return { token, local };
  } catch (error) {
    await releaseLease(jobId, token).catch(() => {});
    throw error;
  }
}
export async function saveMarkdownDraft(
  jobId: string,
  draft: string,
  expectedDocumentDate: string,
  token: string,
) {
  const tx = (await db()).transaction(["jobs", "leases"], "readwrite");
  const lease = await tx.objectStore("leases").get(jobId),
    local = await tx.objectStore("jobs").get(jobId);
  if (
    !lease ||
    lease.token !== token ||
    lease.expiresAt <= Date.now() ||
    !local?.processing?.document ||
    local.processing.document.updatedAt !== expectedDocumentDate
  ) {
    tx.abort();
    await tx.done.catch(() => {});
    throw new Error(
      "Gli appunti sono cambiati in un’altra scheda. Copia le tue modifiche prima di ricaricare la pagina.",
    );
  }
  local.processing.markdownDraft = draft;
  local.job.updatedAt = new Date().toISOString();
  local.processing.document.updatedAt = local.job.updatedAt;
  await tx.objectStore("jobs").put(local);
  await tx.done;
}
export async function renewLease(jobId: string, token: string) {
  const transaction = (await db()).transaction("leases", "readwrite");
  const lease = await transaction.store.get(jobId);
  if (!lease || lease.token !== token || lease.expiresAt <= Date.now()) {
    await transaction.done;
    throw new Error(
      "La sessione di preparazione è stata interrotta. Riprendi la lezione.",
    );
  }
  await transaction.store.put({ ...lease, expiresAt: Date.now() + 30_000 });
  await transaction.done;
}
export async function releaseLease(jobId: string, token: string) {
  const transaction = (await db()).transaction("leases", "readwrite");
  if ((await transaction.store.get(jobId))?.token === token)
    await transaction.store.delete(jobId);
  await transaction.done;
}
export async function savePreparedChunk(
  local: LocalJob,
  metadata: AudioChunk,
  blob: Blob,
  token: string,
) {
  const transaction = (await db()).transaction(
    ["leases", "chunks", "jobs"],
    "readwrite",
  );
  const lease = await transaction.objectStore("leases").get(local.job.id);
  if (!lease || lease.token !== token || lease.expiresAt <= Date.now()) {
    transaction.abort();
    await transaction.done.catch(() => {});
    throw new Error("Preparazione interrotta da un’altra scheda.");
  }
  await transaction.objectStore("chunks").put({
    key: chunkKey(local.job.id, metadata.index),
    jobId: local.job.id,
    metadata,
    blob,
  });
  await transaction.objectStore("jobs").put(local);
  await transaction.done;
}
export async function removeJob(
  jobId: string,
  options: { interrupt?: boolean } = {},
) {
  const transaction = (await db()).transaction(
    ["jobs", "chunks", "leases"],
    "readwrite",
  );
  const lease = await transaction.objectStore("leases").get(jobId);
  if (!options.interrupt && lease && lease.expiresAt > Date.now()) {
    await transaction.done;
    throw new Error("Metti in pausa la lezione prima di eliminarla.");
  }
  const keys = await transaction
    .objectStore("chunks")
    .index("by-job")
    .getAllKeys(jobId);
  for (const key of keys) await transaction.objectStore("chunks").delete(key);
  await transaction.objectStore("jobs").delete(jobId);
  await transaction.objectStore("leases").delete(jobId);
  await transaction.done;
}
export async function reconcileJob(local: LocalJob): Promise<LocalJob> {
  const chunks = await (
    await db()
  ).getAllFromIndex("chunks", "by-job", local.job.id);
  const preparedChunkIds = chunks
    .filter(
      (chunk) =>
        local.manifest.chunks.some(
          (entry) =>
            entry.id === chunk.metadata.id &&
            entry.sha256 === chunk.metadata.sha256,
        ) && chunk.blob.size === chunk.metadata.byteLength,
    )
    .map((chunk) => chunk.metadata.id);
  const complete =
    local.manifest.chunks.length > 0 &&
    preparedChunkIds.length === local.manifest.chunks.length &&
    local.manifest.chunks.at(-1)!.endSeconds >=
      local.manifest.source.durationSeconds - 0.00001;
  return {
    ...local,
    preparedChunkIds,
    job: {
      ...local.job,
      stage: local.job.error
        ? "failed"
        : local.processing?.document
          ? "completed"
          : complete && !local.processing
            ? "ready"
            : local.job.stage === "cancelled"
              ? "cancelled"
              : "paused",
    },
  };
}
