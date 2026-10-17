import { z } from "zod";
import { AUDIO_LIMITS, GROQ_MODELS } from "@/lib/shared/constants";

const optionalSecret = z.string().trim().min(1).optional();
const boundedInteger = (maximum: number, fallback = maximum) =>
  z.coerce.number().int().positive().max(maximum).default(fallback);

export const serverConfigSchema = z
  .object({
    GROQ_API_KEY: optionalSecret,
    OPENAI_API_KEY: optionalSecret,
    OPENROUTER_API_KEY: optionalSecret,
    OPENAI_TOKENS_PER_MINUTE: boundedInteger(2_000_000, 1_000_000),
    OPENAI_BUDGET_MICRO_USD_PER_24H: boundedInteger(5_000_000, 1_000_000),
    OPENAI_BUDGET_MICRO_USD_PER_JOB: boundedInteger(1_000_000, 250_000),
    OPENROUTER_REQUESTS_PER_MINUTE: boundedInteger(20, 15),
    OPENROUTER_REQUESTS_PER_24H: boundedInteger(50, 45),
    GROQ_STT_MODEL: z
      .enum(GROQ_MODELS.transcription)
      .default("whisper-large-v3-turbo"),
    GROQ_NOTES_MODEL: z.enum(GROQ_MODELS.notes).default("openai/gpt-oss-120b"),
    UPSTASH_REDIS_REST_URL: z
      .url()
      .refine((value) => {
        try {
          const url = new URL(value);
          return (
            url.protocol === "https:" &&
            url.hostname.endsWith(".upstash.io") &&
            !url.username &&
            !url.password &&
            url.pathname === "/" &&
            !url.search &&
            !url.hash
          );
        } catch {
          return false;
        }
      }, "Endpoint Redis non consentito.")
      .optional(),
    UPSTASH_REDIS_REST_TOKEN: optionalSecret,
    SESSION_SECRET: z.string().min(32).optional(),
    // Existing production configuration: password stays server-only. Phase 2 will
    // verify it with constant-time comparison and will never persist it in a cookie.
    APP_ACCESS_PASSWORD: z.string().min(8).max(256).optional(),
    APP_ORIGIN: z.url().refine((value) => {
      try {
        const url = new URL(value);
        return (
          url.protocol === "https:" &&
          url.origin === value &&
          !url.username &&
          !url.password
        );
      } catch {
        return false;
      }
    }, "APP_ORIGIN deve essere una origine HTTPS senza percorso."),
    AI_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    MAX_AUDIO_FILE_BYTES: boundedInteger(AUDIO_LIMITS.maxFileBytes),
    MAX_AUDIO_DURATION_SECONDS: boundedInteger(AUDIO_LIMITS.maxDurationSeconds),
    MAX_CHUNK_BYTES: boundedInteger(AUDIO_LIMITS.maxChunkBytes),
    MAX_REQUEST_BYTES: boundedInteger(AUDIO_LIMITS.maxRequestBytes),
    STT_AUDIO_SECONDS_PER_HOUR: boundedInteger(6_600),
    STT_AUDIO_SECONDS_PER_24H: boundedInteger(27_000),
    LLM_TOKENS_PER_MINUTE: boundedInteger(6_000),
    LLM_TOKENS_PER_24H: boundedInteger(160_000),
  })
  .superRefine((value, context) => {
    if (value.MAX_CHUNK_BYTES + 100_000 > value.MAX_REQUEST_BYTES) {
      context.addIssue({
        code: "custom",
        path: ["MAX_REQUEST_BYTES"],
        message: "Margine multipart insufficiente.",
      });
    }
    if (value.AI_ENABLED) {
      for (const key of [
        "GROQ_API_KEY",
        "UPSTASH_REDIS_REST_URL",
        "UPSTASH_REDIS_REST_TOKEN",
        "SESSION_SECRET",
        "APP_ACCESS_PASSWORD",
      ] as const) {
        if (!value[key])
          context.addIssue({
            code: "custom",
            path: [key],
            message: "Variabile obbligatoria con IA abilitata.",
          });
      }
    }
  });

export type ServerConfig = z.infer<typeof serverConfigSchema>;

export function parseServerConfig(
  environment: Record<string, string | undefined>,
): ServerConfig {
  // Empty optional fields in a fresh template are treated as absent. Passwords
  // are not trimmed or otherwise transformed.
  const normalized = Object.fromEntries(
    Object.entries(environment).filter(
      ([, value]) => value !== undefined && value !== "",
    ),
  );
  const result = serverConfigSchema.safeParse(normalized);
  if (!result.success) {
    const fields = [
      ...new Set(
        result.error.issues.map((issue) => issue.path[0]).filter(Boolean),
      ),
    ].join(", ");
    throw new Error(`Configurazione server non valida: ${fields}.`);
  }
  return result.data;
}
