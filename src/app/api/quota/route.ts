import type { NextRequest } from "next/server";
import { requireSession } from "@/lib/server/auth";
import { enforceRateLimit, getQuotaSnapshot } from "@/lib/server/quota";
import { privateJson, routeError } from "@/lib/server/responses";

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
    const [transcription, notes] = await Promise.all([
      getQuotaSnapshot("stt"),
      getQuotaSnapshot("notes"),
    ]);
    return privateJson({ ok: true, data: { transcription, notes } });
  } catch (error) {
    return routeError(error);
  }
}
