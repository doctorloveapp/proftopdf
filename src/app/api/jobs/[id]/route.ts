import type { NextRequest } from "next/server";
import { requireSession } from "@/lib/server/auth";
import { getServerConfig } from "@/lib/server/config";
import { assertSameOrigin, RouteError } from "@/lib/server/http-core";
import { privateJson, routeError } from "@/lib/server/responses";
import { ownerKey, invalidateJobCache } from "@/lib/server/operation";
import { enforceRateLimit } from "@/lib/server/quota";
import { idSchema } from "@/lib/shared/processing";
export const runtime = "nodejs";
export const maxDuration = 20;
export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    assertSameOrigin(request, getServerConfig().APP_ORIGIN);
    const session = await requireSession(request, true);
    await enforceRateLimit(
      [`cleanup:${session.id}`],
      [{ limit: 20, windowMs: 60_000 }],
    );
    const parsed = idSchema.safeParse((await context.params).id);
    if (!parsed.success)
      throw new RouteError(400, "INVALID_JOB", "Lezione non valida.");
    await invalidateJobCache(ownerKey(session), parsed.data);
    return privateJson({ ok: true, data: { deleted: true } });
  } catch (error) {
    return routeError(error);
  }
}
