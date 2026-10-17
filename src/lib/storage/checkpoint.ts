import { z } from "zod";
import { AUDIO_LIMITS } from "@/lib/shared/constants";
import type { LocalJob } from "./jobs";
import {
  MAX_AUDIO_PARTS,
  timelineFingerprint,
  virtualTimeline,
} from "@/lib/audio/timeline";

const sha = z.string().regex(/^[a-f0-9]{64}$/);
const chunkSchema = z
  .object({
    id: z.string().max(80),
    sourcePartIndex: z
      .number()
      .int()
      .min(0)
      .max(MAX_AUDIO_PARTS - 1)
      .optional(),
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
    sources: z
      .array(
        z
          .object({
            index: z
              .number()
              .int()
              .min(0)
              .max(MAX_AUDIO_PARTS - 1),
            name: z.string().min(1).max(255),
            byteLength: z
              .number()
              .int()
              .positive()
              .max(AUDIO_LIMITS.maxFileBytes),
            durationSeconds: z.number().positive().max(7200),
            sha256: sha,
            mimeType: z.string().max(80),
            lastModified: z.number().finite().nonnegative(),
            startSeconds: z.number().nonnegative().max(7200),
          })
          .strict(),
      )
      .min(2)
      .max(MAX_AUDIO_PARTS)
      .optional(),
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
      sources: local.manifest.sources,
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
  if (data.sources) {
    const expected = virtualTimeline(data.sources);
    if (
      data.sources.some(
        (part, index) =>
          part.index !== index ||
          Math.abs(part.startSeconds - expected[index].startSeconds) > 0.00001,
      ) ||
      data.sources.reduce((sum, p) => sum + p.byteLength, 0) !==
        data.source.byteLength ||
      Math.abs(
        data.sources.reduce((sum, p) => sum + p.durationSeconds, 0) -
          data.source.durationSeconds,
      ) > 0.00001 ||
      timelineFingerprint(data.sources) !== data.source.sha256
    )
      throw new Error("La timeline del checkpoint non è valida.");
  }
  for (const [index, chunk] of data.chunks.entries()) {
    const previous = data.chunks[index - 1];
    const part = data.sources?.[chunk.sourcePartIndex ?? -1];
    if (
      (data.sources &&
        (!part ||
          chunk.startSeconds < part.startSeconds ||
          chunk.endSeconds > part.startSeconds + part.durationSeconds + 0.01 ||
          ((!previous || previous.sourcePartIndex !== chunk.sourcePartIndex) &&
            (Math.abs(chunk.startSeconds - part.startSeconds) > 0.00001 ||
              chunk.overlapSeconds !== 0)))) ||
      (!data.sources && (chunk.sourcePartIndex ?? 0) !== 0)
    )
      throw new Error(
        "I confini degli spezzoni del checkpoint non sono validi.",
      );
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
      ...(data.sources ? { sources: data.sources } : {}),
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
