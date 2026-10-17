// Real free Groq + Redis, synthetic TEXT ONLY. No real lecture, audio or server.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { NextRequest } from "next/server";
import { POST as login, DELETE as logout } from "../src/app/api/session/route";
import { POST as notes } from "../src/app/api/notes/route";
import { DELETE as cleanup } from "../src/app/api/jobs/[id]/route";
import {
  SESSION_COOKIE,
  clientAddressKey,
} from "../src/lib/server/auth-crypto";
import { getRedis } from "../src/lib/server/redis";
import { getQuotaSnapshot } from "../src/lib/server/quota";
import {
  planNotes,
  groupTextSources,
  splitFailedNotesUnit,
} from "../src/lib/notes/batching";
import { materializeSections } from "../src/lib/notes/assemble";
import { buildNotesRequest } from "../src/lib/notes/prompt";
import {
  emptyProcessing,
  type NotesRequest,
  type NotesOutput,
} from "../src/lib/shared/processing";
process.loadEnvFile(".env");
const origin = process.env.APP_ORIGIN!,
  jobId = crypto.randomUUID(),
  address = "198.51.100.247";
let cookie = "",
  csrf = "",
  stage = "authentication";
function request(
  path: string,
  method: string,
  body?: BodyInit,
  headers: Record<string, string> = {},
) {
  return new NextRequest(`${origin}${path}`, {
    method,
    body,
    headers: {
      Origin: origin,
      Cookie: cookie,
      "x-csrf-token": csrf,
      ...headers,
    },
  });
}
async function read(response: Response) {
  const result = await response.json();
  if (!response.ok || !result.ok)
    throw new Error(
      `CHECK_${response.status}_${result.error?.code ?? "INVALID_RESPONSE"}`,
    );
  return result.data;
}
const input: NotesRequest = {
  jobId,
  unitId: "source-contract-small",
  mode: "notes",
  attempt: 0,
  title: "Prova sintetica",
  subject: "Fisica",
  languagePolicy: "original",
  sources: [
    {
      id: "s0",
      text: "La seconda legge della dinamica è F = ma. La forza risultante determina l’accelerazione per massa costante.",
      uncertain: false,
    },
    {
      id: "s1",
      text: "Il lavoro di una forza costante è F per spostamento per coseno dell’angolo. L’energia si misura in joule.",
      uncertain: true,
    },
  ],
};
try {
  const before = await getQuotaSnapshot("notes"),
    payload = buildNotesRequest(input);
  assert(
    before.windows
      .filter((w) => w.resource === "tokens")
      .every((w) => w.remaining >= payload.tokenUpperBound),
    "CHECK_429_QUOTA_NOT_AVAILABLE",
  );
  const signed = await login(
    request(
      "/api/session",
      "POST",
      JSON.stringify({ password: process.env.APP_ACCESS_PASSWORD }),
      { "Content-Type": "application/json", "x-forwarded-for": address },
    ),
  );
  csrf = (await read(signed)).csrfToken;
  cookie = `${SESSION_COOKIE}=${signed.cookies.get(SESSION_COOKIE)!.value}`;
  stage = "source-contract";
  const started = performance.now();
  const result = (await read(
    await notes(
      request("/api/notes", "POST", JSON.stringify(input), {
        "Content-Type": "application/json",
      }),
    ),
  )) as NotesOutput;
  const seconds = Math.round((performance.now() - started) / 100) / 10;
  assert.deepEqual(result.coveredSourceIds, ["s0", "s1"]);
  assert.deepEqual(result.uncertainties[0].sourceIds, ["s1"]);
  assert.equal(result.sections.length, 1);
  assert(
    result.usage?.confirmedTokens &&
      result.usage.confirmedTokens < payload.tokenUpperBound,
  );
  stage = "cache-replay";
  const replay = await read(
    await notes(
      request("/api/notes", "POST", JSON.stringify(input), {
        "Content-Type": "application/json",
      }),
    ),
  );
  assert.deepEqual(replay, result);
  const after = await getQuotaSnapshot("notes");
  const daily = (snapshot: typeof before) =>
    snapshot.windows.find(
      (w) => w.resource === "tokens" && w.windowSeconds === 86400,
    )!.used;
  assert.equal(daily(after) - daily(before), result.usage.confirmedTokens);
  const report = {
    checkedAt: new Date().toISOString(),
    ok: true,
    evidence:
      "real free Groq/Redis, two synthetic Italian physics TEXT sources, direct authenticated route call and cache replay; no audio/browser/full-lesson test",
    seconds,
    sources: 2,
    coveredSources: 2,
    uncertaintyWarnings: result.uncertainties.length,
    sections: result.sections.length,
    cacheReplayIdentical: true,
    upstreamRequests: 1,
    usage: result.usage,
    maxCompletionTokens: payload.maxOutput,
  };
  await mkdir("docs", { recursive: true });
  await writeFile(
    "docs/source-contract-live-check.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.error({
    stage,
    code:
      error instanceof Error && /^CHECK_\d+_[A-Z_]+$/.test(error.message)
        ? error.message
        : "CHECK_FAILED",
  });
  process.exitCode = 1;
} finally {
  if (cookie && csrf) {
    await cleanup(request(`/api/jobs/${jobId}`, "DELETE"), {
      params: Promise.resolve({ id: jobId }),
    }).catch(() => {});
    await logout(request("/api/session", "DELETE")).catch(() => {});
  }
  await getRedis()
    .del(
      `proftopdf:v1:rate:login:${clientAddressKey(address, process.env.SESSION_SECRET!)}`,
    )
    .catch(() => {});
}
