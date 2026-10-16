export const APP_NAME = 'ProfToPdf';
export const PRODUCTION_ORIGIN = 'https://proftopdf.velodent.eu';

export const AUDIO_LIMITS = {
  maxFileBytes: 120_000_000,
  maxDurationSeconds: 7_200,
  maxChunkBytes: 3_200_000,
  maxRequestBytes: 3_500_000,
  maxChunkDurationSeconds: 480,
} as const;

export const GROQ_MODELS = {
  transcription: ['whisper-large-v3-turbo', 'whisper-large-v3'],
  notes: ['openai/gpt-oss-120b', 'openai/gpt-oss-20b'],
} as const;

export type TranscriptionModel = (typeof GROQ_MODELS.transcription)[number];
export type NotesModel = (typeof GROQ_MODELS.notes)[number];
