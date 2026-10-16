import "server-only";
import Groq from "groq-sdk";
import { requireAiConfig } from "./config";
import { GROQ_API_ORIGIN } from "@/lib/shared/constants";

let groq: Groq | undefined;

export function getGroq(): Groq {
  const config = requireAiConfig();
  if (!config.GROQ_API_KEY) throw new Error("Provider IA non configurato.");
  groq ??= new Groq({
    apiKey: config.GROQ_API_KEY,
    // SDK 1.x resource paths already include /openai/v1.
    baseURL: GROQ_API_ORIGIN,
    timeout: 90_000,
    maxRetries: 0,
  });
  return groq;
}

export function getGroqModels() {
  const config = requireAiConfig();
  return {
    transcription: config.GROQ_STT_MODEL,
    notes: config.GROQ_NOTES_MODEL,
  } as const;
}

// Inference routes require authentication, CSRF and a server-verified quota.
