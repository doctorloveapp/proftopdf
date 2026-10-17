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
  const passages = [
    "La posizione individua un punto rispetto a un riferimento. Lo spostamento è la differenza vettoriale tra posizione finale e iniziale; non coincide sempre con la distanza percorsa.",
    "La velocità media è il rapporto tra spostamento e intervallo temporale. La velocità istantanea è il limite di questo rapporto per intervalli sempre più piccoli.",
    "L’accelerazione misura la variazione della velocità nel tempo. Un cambiamento di direzione implica accelerazione anche quando il modulo della velocità resta costante.",
    "Nel moto rettilineo uniforme la velocità è costante. La legge oraria è x = x0 + vt; il grafico posizione-tempo è una retta la cui pendenza rappresenta la velocità.",
    "Nel moto uniformemente accelerato valgono v = v0 + at e x = x0 + v0t + at²/2. Le formule richiedono accelerazione costante nell’intervallo considerato.",
    "Il principio d’inerzia descrive un corpo con forza risultante nulla: mantiene la quiete oppure il moto rettilineo uniforme rispetto a un sistema inerziale.",
    "La seconda legge della dinamica è F = ma per massa costante. La forza risultante è la somma vettoriale delle forze e determina l’accelerazione del corpo.",
    "Nel principio di azione e reazione le due forze agiscono su corpi differenti. Non si annullano nel diagramma delle forze di un singolo corpo.",
    "Il peso è una forza gravitazionale di modulo mg. La massa si misura in chilogrammi, il peso in newton; una bilancia a molla misura una forza.",
    "Sul piano inclinato il peso si scompone in mg sen α e mg cos α. La reazione normale dipende dalle forze perpendicolari al piano e non è sempre uguale al peso.",
    "L’attrito statico si adatta entro il valore massimo μs N. L’attrito dinamico si oppone allo scorrimento e ha modulo μd N nel modello scolastico semplificato.",
    "Il lavoro di una forza costante è W = Fs cos θ. Una forza perpendicolare allo spostamento compie lavoro nullo; il segno dipende dall’orientamento relativo.",
    "L’energia cinetica è mv²/2. Il teorema dell’energia cinetica collega la sua variazione al lavoro totale delle forze applicate al corpo.",
    "L’energia potenziale gravitazionale vicino alla superficie terrestre è mgh. La quota zero è arbitraria; differenze di energia potenziale hanno significato fisico.",
    "Se agiscono solo forze conservative, l’energia meccanica resta costante. L’attrito può trasformare parte dell’energia meccanica in energia interna.",
    "La potenza media è il lavoro diviso per il tempo impiegato. Si misura in watt e distingue processi che trasferiscono la stessa energia in intervalli diversi.",
    "La quantità di moto è il prodotto della massa per la velocità. In un sistema isolato la quantità di moto totale si conserva durante un urto.",
    "Un urto elastico conserva anche l’energia cinetica totale. In un urto completamente anelastico i corpi restano uniti; la quantità di moto si conserva se il sistema è isolato.",
    "La pressione è il rapporto tra forza normale e area. A parità di forza, un’area minore produce pressione maggiore; l’unità SI è il pascal.",
    "Nel modello del gas ideale pV = nRT. La temperatura va espressa in kelvin; il modello trascura volume proprio delle particelle e interazioni a distanza.",
  ];
  const plan = await planNotes(
    passages.map((text, index) => ({
      id: `s3-${index}`,
      chunkId: "c3",
      startSeconds: index * 20,
      endSeconds: (index + 1) * 20,
      text,
      status: index % 3 === 0 ? ("uncertain" as const) : ("confirmed" as const),
    })),
    emptyProcessing(),
    context,
  );
  const unit = plan.units[0];
  plan.units = [unit];
  const input: NotesRequest = {
    ...context,
    unitId: unit.id,
    mode: "notes",
    attempt: 0,
    sources: unit.sources,
  };
  const before = await getQuotaSnapshot("notes");
  stage = "dense-notes";
  const start = performance.now(),
    noteMap: Record<string, NotesOutput> = {};
  let failedBatches = 0,
    reservationSum = 0;
  for (let index = 0; index < plan.units.length; index++) {
    const batch = plan.units[index],
      batchInput = { ...input, unitId: batch.id, sources: batch.sources };
    reservationSum += buildNotesRequest(batchInput).tokenUpperBound;
    try {
      const output: NotesOutput = await infer(batchInput);
      assert.deepEqual(
        output.coveredSourceIds,
        batch.sources.map((source) => source.id),
      );
      const warnings = new Set(
        output.uncertainties.flatMap((warning) => warning.sourceIds),
      );
      assert(
        batch.sources
          .filter((source) => source.uncertain)
          .every((source) => warnings.has(source.id)),
      );
      assert.deepEqual(await infer(batchInput), output, "CACHE_REPLAY_CHANGED");
      noteMap[batch.id] = output;
    } catch (error) {
      if (
        error instanceof Error &&
        ["CHECK_502_NOTES_TRUNCATED", "CHECK_502_NOTES_COVERAGE"].includes(
          error.message,
        ) &&
        splitFailedNotesUnit(plan, batch.id)
      ) {
        failedBatches++;
        index--;
        continue;
      }
      throw error;
    }
  }
  const afterNotes = await getQuotaSnapshot("notes");
  const noteSeconds = (performance.now() - start) / 1000;
  const sections = materializeSections(plan.units, noteMap);
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
  assert.equal(
    daily(after, "requests") - daily(before, "requests"),
    plan.units.length + failedBatches + 1,
  );
  assert(
    noteTokens > 0 && noteTokens < reservationSum,
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
    uncertainSources: input.sources.filter((source) => source.uncertain).length,
    coveredSources: Object.values(noteMap).reduce(
      (n, output) => n + output.coveredSourceIds.length,
      0,
    ),
    uncertaintyWarnings: Object.values(noteMap).reduce(
      (n, output) => n + output.uncertainties.length,
      0,
    ),
    sourceCharacters: input.sources.reduce((n, s) => n + s.text.length, 0),
    notesSections: sections.length,
    glossaryTerms: Object.values(noteMap).reduce(
      (n, output) => n + output.glossary.length,
      0,
    ),
    chapters: outline.chapters.length,
    cacheReplayIdentical: true,
    upstreamRequests: plan.units.length + failedBatches + 1,
    splitBatches: failedBatches,
    notes: {
      reservation: reservationSum,
      confirmedTokens: noteTokens,
    },
    outline: {
      reservation: buildNotesRequest(outlineInput).tokenUpperBound,
      confirmedTokens: outlineTokens,
    },
  };
  await mkdir("docs", { recursive: true });
  await writeFile(
    "docs/notes-coverage-live-check.json",
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
