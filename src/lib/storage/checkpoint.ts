import { z } from "zod";
import { AUDIO_LIMITS } from "@/lib/shared/constants";
import type { LocalJob } from "./jobs";

const sha = z.string().regex(/^[a-f0-9]{64}$/);
const chunkSchema = z
  .object({
    id: z.string().max(80),
    index: z.number().int().min(0).max(1500),
    startSeconds: z.number().nonnegative(),
    endSeconds: z.number().positive().max(7200.1),
    overlapSeconds: z.number().nonnegative().max(5),
    byteLength: z.number().int().positive().max(AUDIO_LIMITS.maxChunkBytes),
    sha256: sha,
    mimeType: z.string().max(80),
    container: z.string().max(20),
    codec: z.string().max(40),
  })
  .strict();
const schema = z
  .object({
    schema: z.literal("proftopdf/checkpoint/v1"),
    title: z.string().min(1).max(200),
    subject: z.string().max(200),
    language: z.enum(["it", "auto"]),
    source: z
      .object({
        name: z.string().min(1).max(255),
        byteLength: z.number().int().positive().max(AUDIO_LIMITS.maxFileBytes),
        durationSeconds: z.number().positive().max(7200),
        sha256: sha,
        mimeType: z.string().max(80),
      })
      .strict(),
    chunks: z.array(chunkSchema).max(1500),
  })
  .strict();

export function exportCheckpoint(local: LocalJob) {
  return JSON.stringify(
    {
      schema: "proftopdf/checkpoint/v1",
      title: local.title,
      subject: local.subject,
      language: local.manifest.language === "auto" ? "auto" : "it",
      source: local.manifest.source,
      chunks: local.manifest.chunks,
    },
    null,
    2,
  );
}
export function importCheckpoint(text: string): LocalJob {
  if (text.length > 2_000_000) throw new Error("Checkpoint troppo grande.");
  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch {
    throw new Error("Checkpoint non valido.");
  }
  const parsed = schema.safeParse(input);
  if (!parsed.success)
    throw new Error("Il file non è un checkpoint ProfToPdf compatibile.");
  const data = parsed.data;
  for (const [index, chunk] of data.chunks.entries()) {
    const previous = data.chunks[index - 1];
    if (
      chunk.index !== index ||
      chunk.endSeconds <= chunk.startSeconds ||
      chunk.endSeconds - chunk.startSeconds > 480 ||
      chunk.endSeconds > data.source.durationSeconds + 0.01 ||
      (!previous && chunk.startSeconds !== 0) ||
      (previous &&
        (chunk.startSeconds > previous.endSeconds ||
          chunk.startSeconds <= previous.startSeconds))
    )
      throw new Error("La sequenza dei segmenti del checkpoint non è valida.");
  }
  const id = crypto.randomUUID(),
    now = new Date().toISOString();
  return {
    title: data.title,
    subject: data.subject,
    pdfGenerationTracked: true,
    preparedChunkIds: [],
    manifest: {
      version: 1,
      jobId: id,
      language: data.language,
      source: data.source,
      chunks: data.chunks.map((chunk) => ({
        ...chunk,
        id: `${id}:${chunk.index}`,
      })),
    },
    job: {
      version: 1,
      id,
      stage: "paused",
      createdAt: now,
      updatedAt: now,
      sourceFingerprint: data.source.sha256,
      completedChunkIds: [],
      completedNotesUnitIds: [],
      retryAt: null,
      error: null,
    },
  };
}
