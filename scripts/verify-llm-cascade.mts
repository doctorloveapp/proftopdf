// Authorized paid native OpenAI + real Redis, synthetic TEXT ONLY; no browser/server/audio.
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
import { llmQuotaSnapshot } from "../src/lib/server/llm/quota";
import { LLM_ROUTING_REVISION } from "../src/lib/shared/processing";
import {
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
  unitId: "cascade-large-probe",
  mode: "notes",
  attempt: 0,
  title: "Dinamica sintetica",
  subject: "Fisica",
  languagePolicy: "original",
  sources: Array.from({ length: 30 }, (_, index) => ({
    id: `s${index}p0`,
    text: `Argomento ${index + 1}. La seconda legge della dinamica vale F = ma per massa costante. Con massa 2 kg e accelerazione 3 m/s2, la forza risultante e' 6 N, non 5 N. Il lavoro di una forza costante si calcola con W = F s cos(theta). Se forza e spostamento sono perpendicolari il lavoro e' zero. Non confondere energia cinetica e quantita' di moto. `.repeat(
      2,
    ),
    uncertain: index === 29,
  })),
};
async function infer(value: NotesRequest) {
  const response = await notes(
    request("/api/notes", "POST", JSON.stringify(value), {
      "Content-Type": "application/json",
      "x-notes-routing-version": LLM_ROUTING_REVISION,
    }),
  );
  const data = await read(response);
  assert(!data.state, "PRIMARY_UNEXPECTEDLY_REROUTED");
  return data;
}
try {
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
  stage = "large-native-notes";
  const start = performance.now();
  const result = (await infer(input)) as NotesOutput;
  const noteSeconds = Math.round((performance.now() - start) / 100) / 10;
  assert.deepEqual(
    result.coveredSourceIds,
    input.sources.map((source) => source.id),
  );
  assert.equal(result.usage?.legs?.at(-1)?.provider, "openai");
  const firstQuota = await llmQuotaSnapshot("openai");
  stage = "cache-replay";
  assert.deepEqual(await infer(input), result);
  const replayQuota = await llmQuotaSnapshot("openai");
  assert.deepEqual(
    replayQuota.windows.map((w) => [w.used, w.reserved]),
    firstQuota.windows.map((w) => [w.used, w.reserved]),
  );
  stage = "outline";
  const outlineInput: NotesRequest = {
    ...input,
    unitId: "cascade-outline-probe",
    mode: "outline",
    sources: Array.from({ length: 8 }, (_, index) => ({
      id: `section-${index}`,
      text: `Capitolo di dinamica ${index}`,
      uncertain: false,
    })),
  };
  const outlineStart = performance.now();
  const outline = await infer(outlineInput);
  assert.deepEqual(
    outline.chapters.flatMap((c: any) => c.sectionIds),
    outlineInput.sources.map((s) => s.id),
  );
  const report = {
    checkedAt: new Date().toISOString(),
    ok: true,
    evidence:
      "real direct authenticated route integration: paid native OpenAI and Redis; 30 synthetic text sources plus outline; no audio/mobile/deploy",
    sourceCount: 30,
    requestJsonBytes: Buffer.byteLength(JSON.stringify(input)),
    coveredSources: result.coveredSourceIds.length,
    uncertaintyWarnings: result.uncertainties.length,
    noteSeconds,
    outlineSeconds: Math.round((performance.now() - outlineStart) / 100) / 10,
    nativePrimary: true,
    cacheReplayIdentical: true,
    cacheReplayNoQuotaCharge: true,
    notesUsage: result.usage,
    outlineUsage: outline.usage,
    upstreamCalls: 2,
  };
  await mkdir("docs", { recursive: true });
  await writeFile(
    "docs/llm-cascade-live-check.json",
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
