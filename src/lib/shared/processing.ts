import { z } from "zod";
import type { LectureDocument } from "./types";

export const PROCESSING_REVISION = "pipeline-2026-10-16-v1";
export const NOTES_SOURCE_BYTES = 1200;
export const NOTES_MAX_OUTPUT = 1800;
export const MAX_ATTEMPTS = 3;
export const idSchema = z.string().uuid();
export const sourceItemSchema = z
  .object({
    id: z.string().regex(/^[a-zA-Z0-9:_-]{1,90}$/),
    text: z.string().min(1).max(2000),
    uncertain: z.boolean(),
  })
  .strict();
export type SourceItem = z.infer<typeof sourceItemSchema>;
export const notesRequestSchema = z
  .object({
    jobId: idSchema,
    unitId: z.string().regex(/^[a-z0-9-]{1,80}$/),
    mode: z.enum(["notes", "outline"]),
    attempt: z
      .number()
      .int()
      .min(0)
      .max(MAX_ATTEMPTS - 1),
    title: z.string().min(1).max(200),
    subject: z.string().max(200),
    languagePolicy: z.literal("original").optional(),
    sources: z.array(sourceItemSchema).min(1).max(30),
  })
  .strict();
export type NotesRequest = z.infer<typeof notesRequestSchema>;
export const notesOutputSchema = z
  .object({
    sections: z
      .array(
        z
          .object({
            title: z.string().min(1).max(200),
            paragraphs: z.array(z.string().min(1).max(4000)).max(8),
            bullets: z.array(z.string().min(1).max(1500)).max(12),
            concepts: z.array(z.string().min(1).max(1500)).max(8),
            sourceIds: z.array(z.string()).min(1).max(30),
          })
          .strict(),
      )
      .min(1)
      .max(5),
    glossary: z
      .array(
        z
          .object({
            term: z.string().min(1).max(100),
            definition: z.string().min(1).max(1500),
            sourceIds: z.array(z.string()).min(1).max(30),
          })
          .strict(),
      )
      .max(8),
    uncertainties: z
      .array(
        z
          .object({
            text: z.string().min(1).max(1500),
            sourceIds: z.array(z.string()).min(1).max(30),
          })
          .strict(),
      )
      .max(8),
    coveredSourceIds: z.array(z.string()).min(1).max(30),
  })
  .strict();
export type NotesOutput = z.infer<typeof notesOutputSchema>;
export const outlineOutputSchema = z
  .object({
    chapters: z
      .array(
        z
          .object({
            title: z.string().min(1).max(200),
            sectionIds: z.array(z.string()).min(1).max(30),
          })
          .strict(),
      )
      .min(1)
      .max(12),
  })
  .strict();
export type OutlineOutput = z.infer<typeof outlineOutputSchema>;
export interface ChunkTranscript {
  sha256: string;
  model: string;
  durationSeconds: number;
  status: "transcribed" | "missing";
  segments: { start: number; end: number; text: string; uncertain: boolean }[];
}
export interface ProcessingData {
  revision: string;
  transcripts: Record<string, ChunkTranscript>;
  attempts: Record<string, number>;
  accurateChunks: number[];
  notes: Record<string, NotesOutput>;
  outlines: Record<string, OutlineOutput>;
  document?: LectureDocument;
  failedChunkIndex?: number;
  failedUnitId?: string;
  markdownDraft?: string;
}
export function emptyProcessing(): ProcessingData {
  return {
    revision: PROCESSING_REVISION,
    transcripts: {},
    attempts: {},
    accurateChunks: [],
    notes: {},
    outlines: {},
  };
}
export const utf8Bytes = (value: string) =>
  new TextEncoder().encode(value).byteLength;
