import type { NextRequest } from "next/server";
import { requireSession } from "@/lib/server/auth";
import { enforceRateLimit, getQuotaSnapshot } from "@/lib/server/quota";
import { privateJson, routeError } from "@/lib/server/responses";
import { llmQuotaSnapshot } from "@/lib/server/llm/quota";
import { LLM_ROUTING_REVISION } from "@/lib/shared/processing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 20;

export async function GET(request: NextRequest) {
  try {
    const session = await requireSession(request);
    await enforceRateLimit(
      [`quota:${session.id}`],
      [{ limit: 10, windowMs: 60_000 }],
    );
    const [transcription, groq, openai, openrouter] = await Promise.all([
      getQuotaSnapshot("stt"),
      getQuotaSnapshot("notes"),
      llmQuotaSnapshot("openai"),
      llmQuotaSnapshot("openrouter"),
    ]);
    const notesProviders = [openai, openrouter, groq];
    const available = notesProviders.some((provider) => provider.available);
    return privateJson({
      ok: true,
      data: {
        transcription,
        notes: {
          ...openai,
          available,
          reason: available ? "available" : "unavailable",
        },
        notesProviders,
        routingRevision: LLM_ROUTING_REVISION,
      },
    });
  } catch (error) {
    return routeError(error);
  }
}
