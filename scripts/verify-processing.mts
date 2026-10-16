// One short synthetic Italian STT + one notes unit + one outline; real Redis
// reservations and real free Groq. No localhost server, browser or Git.
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { POST as login, DELETE as logout } from "../src/app/api/session/route";
import { POST as transcribe } from "../src/app/api/transcribe/route";
import { POST as notes } from "../src/app/api/notes/route";
import { DELETE as cleanup } from "../src/app/api/jobs/[id]/route";
import {
  SESSION_COOKIE,
  clientAddressKey,
} from "../src/lib/server/auth-crypto";
import { getRedis } from "../src/lib/server/redis";
import { getQuotaSnapshot } from "../src/lib/server/quota";
import {
  buildTextUnits,
  materializeSections,
  buildOutlineUnits,
} from "../src/lib/notes/assemble";
import { buildNotesRequest } from "../src/lib/notes/request";
import type {
  ChunkTranscript,
  NotesOutput,
} from "../src/lib/shared/processing";
process.loadEnvFile(".env");
const origin = process.env.APP_ORIGIN!,
  jobId = crypto.randomUUID(),
  address = "198.51.100.248";
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
async function data(response: Response) {
  const result = await response.json();
  if (!response.ok || !result.ok)
    throw new Error(
      `CHECK_${response.status}_${result.error?.code ?? "INVALID_RESPONSE"}`,
    );
  return result.data;
}
try {
  assert.equal(
    (await transcribe(request("/api/transcribe", "POST", new Uint8Array([0]))))
      .status,
    401,
  );
  const signed = await login(
    request(
      "/api/session",
      "POST",
      JSON.stringify({ password: process.env.APP_ACCESS_PASSWORD }),
      { "Content-Type": "application/json", "x-forwarded-for": address },
    ),
  );
  const session = await data(signed);
  csrf = session.csrfToken;
  cookie = `${SESSION_COOKIE}=${signed.cookies.get(SESSION_COOKIE)!.value}`;
  assert.equal(
    (
      await transcribe(
        request("/api/transcribe", "POST", new Uint8Array([0]), {
          "x-csrf-token": "invalid",
        }),
      )
    ).status,
    403,
  );
  const before = await Promise.all([
    getQuotaSnapshot("stt"),
    getQuotaSnapshot("notes"),
  ]);
  const bytes = new Uint8Array(await readFile("docs/synthetic-lecture.wav")),
    sha = createHash("sha256").update(bytes).digest("hex");
  const headers = {
    "Content-Type": "application/octet-stream",
    "x-job-id": jobId,
    "x-chunk-index": "0",
    "x-chunk-start": "0",
    "x-audio-sha256": sha,
    "x-source-sha256": sha,
    "x-attempt": "0",
    "x-accurate": "false",
  };
  stage = "stt";
  const result: ChunkTranscript = await data(
    await transcribe(request("/api/transcribe", "POST", bytes, headers)),
  );
  assert(
    result.segments.some((s) => /energia/i.test(s.text)),
    "STT_TOPIC_NOT_RECOGNIZED",
  );
  const replay = await data(
    await transcribe(request("/api/transcribe", "POST", bytes, headers)),
  );
  assert.deepEqual(replay, result);
  const segments = result.segments.map((s, i) => ({
    id: `s0-${i}`,
    chunkId: "chunk-0",
    startSeconds: s.start,
    endSeconds: s.end,
    text: s.text,
    status: s.uncertain ? ("uncertain" as const) : ("confirmed" as const),
  }));
  const units = buildTextUnits(segments);
  assert.equal(units.length, 1, "EXPECTED_ONE_SMALL_UNIT");
  const unit = units[0];
  assert(unit, "NO_TEXT_UNIT");
  const input = {
    jobId,
    unitId: unit.id,
    mode: "notes" as const,
    attempt: 0,
    title: "Conservazione dell’energia",
    subject: "Fisica",
    sources: unit.sources,
  };
  stage = "notes";
  const output: NotesOutput = await data(
    await notes(
      request("/api/notes", "POST", JSON.stringify(input), {
        "Content-Type": "application/json",
      }),
    ),
  );
  const noteMap = { [unit.id]: output },
    sections = materializeSections([unit], noteMap),
    outlineUnit = buildOutlineUnits(sections)[0];
  stage = "outline";
  const outline = await data(
    await notes(
      request(
        "/api/notes",
        "POST",
        JSON.stringify({
          ...input,
          mode: "outline",
          unitId: outlineUnit.id,
          sources: outlineUnit.sources,
        }),
        { "Content-Type": "application/json" },
      ),
    ),
  );
  assert(outline.chapters.length > 0);
  const after = await Promise.all([
    getQuotaSnapshot("stt"),
    getQuotaSnapshot("notes"),
  ]);
  const daily = (snap: (typeof before)[number], resource: string) =>
    snap.windows.find(
      (w) => w.resource === resource && w.windowSeconds === 86400,
    )!.used;
  const report = {
    checkedAt: new Date().toISOString(),
    ok: true,
    mode: "direct route integration, no local server/browser",
    syntheticItalianAudio: true,
    unauthenticatedRejected: true,
    csrfEnforced: true,
    sttReplayIdentical: true,
    upstreamCalls: { stt: 1, notes: 1, outline: 1 },
    durationSeconds: result.durationSeconds,
    transcriptSegments: result.segments.length,
    transcriptCharacters: result.segments.reduce(
      (n, s) => n + s.text.length,
      0,
    ),
    topicEnergyRecognized: true,
    notesSections: output.sections.length,
    glossaryTerms: output.glossary.length,
    chapters: outline.chapters.length,
    notesReservedUpperBound: buildNotesRequest(input).tokenUpperBound,
    audioSecondsCounted:
      daily(after[0], "audio-seconds") - daily(before[0], "audio-seconds"),
    tokensCounted: daily(after[1], "tokens") - daily(before[1], "tokens"),
    requestsCounted: {
      stt: daily(after[0], "requests") - daily(before[0], "requests"),
      notes: daily(after[1], "requests") - daily(before[1], "requests"),
    },
  };
  assert.equal(report.requestsCounted.stt, 1);
  await mkdir("docs", { recursive: true });
  await writeFile(
    "docs/processing-live-check.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  // Print only our fixed check code, never SDK errors, credentials or text.
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
