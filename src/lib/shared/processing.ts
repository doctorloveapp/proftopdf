import { z } from "zod";
import type { LectureDocument, NotesUsage } from "./types";

export const PROCESSING_REVISION = "pipeline-2026-10-16-v1";
export const NOTES_SOURCE_BYTES = 1200;
export const NOTES_MAX_OUTPUT = 2400;
export const MAX_ATTEMPTS = 3;
export const NOTES_RESULT_BYTES = 44_000;
export const NOTES_BUDGET_REVISION = "source-map-v1";
export const STT_UNCERTAINTY_NOTICE =
  "Questo passaggio della trascrizione è segnalato come incerto: confrontalo con la registrazione originale prima di studiarlo.";
export const REPAIRABLE_NOTES_CODES = new Set([
  "NOTES_INVALID",
  "NOTES_JSON",
  "NOTES_EMPTY",
  "NOTES_CONTENT",
  "NOTES_COVERAGE",
  "NOTES_TRUNCATED",
]);
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
    sections: z.array(
      z
        .object({
          title: z.string(),
          paragraphs: z.array(z.string()),
          bullets: z.array(z.string()),
          concepts: z.array(z.string()),
          sourceIds: z.array(z.string()),
        })
        .strict(),
    ),
    glossary: z.array(
      z
        .object({
          term: z.string(),
          definition: z.string(),
          sourceIds: z.array(z.string()),
        })
        .strict(),
    ),
    uncertainties: z.array(
      z
        .object({
          text: z.string(),
          sourceIds: z.array(z.string()),
        })
        .strict(),
    ),
    coveredSourceIds: z.array(z.string()),
  })
  .strict();
export type NotesOutput = z.infer<typeof notesOutputSchema> & {
  usage?: NotesUsage;
};
export const outlineOutputSchema = z
  .object({
    chapters: z.array(
      z
        .object({
          title: z.string(),
          sectionIds: z.array(z.string()),
        })
        .strict(),
    ),
  })
  .strict();
export type OutlineOutput = z.infer<typeof outlineOutputSchema> & {
  usage?: NotesUsage;
};
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
  quotaBlockedUnitId?: string;
  notesUsage?: Record<string, NotesUsage>;
  usageHistoryComplete?: boolean;
  markdownDraft?: string;
  notesPlan?: {
    version: "bpe-v1";
    budgetRevision?: string;
    splitDepths?: Record<string, number>;
    sourceDigest: string;
    units: { id: string; sources: SourceItem[] }[];
  };
}
export function emptyProcessing(): ProcessingData {
  return {
    revision: PROCESSING_REVISION,
    transcripts: {},
    attempts: {},
    accurateChunks: [],
    notes: {},
    outlines: {},
    notesUsage: {},
    usageHistoryComplete: true,
  };
}
export const utf8Bytes = (value: string) =>
  new TextEncoder().encode(value).byteLength;
