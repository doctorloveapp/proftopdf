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
import { planNotes, groupTextSources } from "../src/lib/notes/batching";
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
async function infer(input: NotesRequest) {
  for (let i = 0; i < 3; i++) {
    const response = await notes(
      request("/api/notes", "POST", JSON.stringify(input), {
        "Content-Type": "application/json",
      }),
    );
    if (response.status !== 429) return read(response);
    const result = await response.json(),
      delay = Date.parse(result.error?.retryAt) - Date.now();
    if (!Number.isFinite(delay) || delay > 65_000)
      throw new Error("CHECK_429_QUOTA_NOT_AVAILABLE");
    console.log(
      JSON.stringify({
        stage,
        quotaWaitSeconds: Math.ceil(Math.max(0, delay) / 1000),
      }),
    );
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(50, delay + 100)),
    );
  }
  throw new Error("CHECK_429_REPEATED_QUOTA");
}
const daily = (
  snap: Awaited<ReturnType<typeof getQuotaSnapshot>>,
  resource: string,
) =>
  snap.windows.find(
    (w) => w.resource === resource && w.windowSeconds === 86400,
  )!.used;
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
  const context = {
    jobId,
    title: "Dinamica: prova sintetica",
    subject: "Fisica",
    languagePolicy: "original" as const,
  };
  const text =
    "La seconda legge della dinamica è F = ma. La forza risultante è la somma vettoriale delle forze applicate al corpo. Consideriamo un piano inclinato: il peso si scompone in una componente parallela e una perpendicolare. Il lavoro trasferisce energia al sistema e l’attrito dissipa energia meccanica. La massa si misura in kg, la forza in newton e il lavoro in joule. ".repeat(
      30,
    );
  const plan = await planNotes(
    [
      {
        id: "s0",
        chunkId: "c0",
        startSeconds: 0,
        endSeconds: 600,
        text,
        status: "confirmed",
      },
    ],
    emptyProcessing(),
    context,
  );
  const unit = plan.units[0],
    input: NotesRequest = {
      ...context,
      unitId: unit.id,
      mode: "notes",
      attempt: 0,
      sources: unit.sources,
    };
  const before = await getQuotaSnapshot("notes");
  stage = "dense-notes";
  const start = performance.now(),
    output: NotesOutput = await infer(input),
    afterNotes = await getQuotaSnapshot("notes");
  const noteSeconds = (performance.now() - start) / 1000;
  assert.deepEqual(await infer(input), output, "CACHE_REPLAY_CHANGED");
  const sections = materializeSections([unit], { [unit.id]: output });
  const outlines = await groupTextSources(
    sections.map((s) => ({ id: s.id, text: s.title, uncertain: false })),
    context,
    "outline",
  );
  assert.equal(outlines.length, 1);
  const outlineInput: NotesRequest = {
    ...input,
    unitId: outlines[0].id,
    mode: "outline",
    sources: outlines[0].sources,
  };
  stage = "outline";
  const outline = await infer(outlineInput),
    after = await getQuotaSnapshot("notes");
  const noteTokens = daily(afterNotes, "tokens") - daily(before, "tokens");
  const outlineTokens = daily(after, "tokens") - daily(afterNotes, "tokens");
  assert.equal(daily(after, "requests") - daily(before, "requests"), 2);
  assert(
    noteTokens > 0 && noteTokens < buildNotesRequest(input).tokenUpperBound,
    "NOTES_USAGE_NOT_SETTLED",
  );
  assert(
    outlineTokens > 0 &&
      outlineTokens < buildNotesRequest(outlineInput).tokenUpperBound,
    "OUTLINE_USAGE_NOT_SETTLED",
  );
  const report = {
    checkedAt: new Date().toISOString(),
    ok: true,
    evidence:
      "real free Groq/Redis, synthetic Italian physics TEXT; direct route calls, no audio or browser",
    noteSeconds: Math.round(noteSeconds * 10) / 10,
    sources: input.sources.length,
    sourceCharacters: input.sources.reduce((n, s) => n + s.text.length, 0),
    notesSections: output.sections.length,
    glossaryTerms: output.glossary.length,
    chapters: outline.chapters.length,
    cacheReplayIdentical: true,
    upstreamRequests: 2,
    notes: {
      reservation: buildNotesRequest(input).tokenUpperBound,
      confirmedTokens: noteTokens,
    },
    outline: {
      reservation: buildNotesRequest(outlineInput).tokenUpperBound,
      confirmedTokens: outlineTokens,
    },
  };
  await mkdir("docs", { recursive: true });
  await writeFile(
    "docs/notes-live-check.json",
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
