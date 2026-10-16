/** All audio timestamps and durations are in seconds; sizes are decimal bytes. */
export interface AudioChunk {
  id: string;
  index: number;
  startSeconds: number;
  endSeconds: number;
  overlapSeconds: number;
  byteLength: number;
  sha256: string;
  mimeType: string;
  container: string;
  codec: string;
}

export interface AudioManifest {
  version: 1;
  jobId: string;
  source: {
    name: string;
    byteLength: number;
    durationSeconds: number;
    sha256: string;
    mimeType: string;
  };
  language: string;
  chunks: AudioChunk[];
}

export interface TranscriptSegment {
  id: string;
  chunkId: string;
  startSeconds: number;
  endSeconds: number;
  text: string;
  status: 'confirmed' | 'uncertain' | 'missing';
  confidence?: number;
}

export type InlineContent = { text: string; bold?: boolean; italic?: boolean };
export type DocumentBlock =
  | { type: 'paragraph'; content: InlineContent[]; sourceSegmentIds: string[] }
  | { type: 'list'; ordered: boolean; items: InlineContent[][]; sourceSegmentIds: string[] }
  | { type: 'key-concept'; content: InlineContent[]; sourceSegmentIds: string[] }
  | { type: 'uncertainty'; text: string; sourceSegmentIds: string[] };

export interface LectureSection {
  id: string;
  title: string;
  level: 1 | 2 | 3;
  blocks: DocumentBlock[];
  sourceSegmentIds: string[];
}

export interface LectureDocument {
  version: 1;
  jobId: string;
  title: string;
  subject: string;
  language: string;
  createdAt: string;
  updatedAt: string;
  sections: LectureSection[];
  glossary: { term: string; definition: string; sourceSegmentIds: string[] }[];
  gaps: { startSeconds: number; endSeconds: number; reason: string }[];
  complete: boolean;
}

export interface QuotaWindow {
  resource: 'audio-seconds' | 'tokens' | 'requests' | 'redis-commands';
  windowSeconds: number;
  limit: number;
  used: number;
  reserved: number;
  remaining: number;
  retryAt: string | null;
}

export interface QuotaState {
  checkedAt: string;
  available: boolean;
  provider: 'groq' | 'upstash';
  model: string | null;
  windows: QuotaWindow[];
  reason: 'available' | 'quota-exhausted' | 'unavailable' | 'disabled';
}

export type ProcessingStage =
  | 'selected' | 'analyzing' | 'preparing' | 'transcribing' | 'waiting-quota'
  | 'generating-notes' | 'generating-pdf' | 'paused' | 'completed' | 'cancelled' | 'failed';

export interface ProcessingJob {
  version: 1;
  id: string;
  stage: ProcessingStage;
  createdAt: string;
  updatedAt: string;
  completedChunkIds: string[];
  completedNotesUnitIds: string[];
  sourceFingerprint: string;
  retryAt: string | null;
  error: AppError | null;
}

export interface AppError {
  code: string;
  message: string;
  recoverable: boolean;
  retryAt: string | null;
}

export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: AppError };
