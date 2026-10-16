import "server-only";
import Groq from "groq-sdk";
import { requireAiConfig } from "./config";

let groq: Groq | undefined;

export function getGroq(): Groq {
  const config = requireAiConfig();
  if (!config.GROQ_API_KEY) throw new Error("Provider IA non configurato.");
  groq ??= new Groq({
    apiKey: config.GROQ_API_KEY,
    baseURL: "https://api.groq.com/openai/v1",
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

// No public inference endpoint is exposed until authentication and quota
// reservations exist. A reachable scaffold must never be an open paid/free proxy.
