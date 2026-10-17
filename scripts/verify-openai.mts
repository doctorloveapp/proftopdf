// Real PAID OpenAI, explicitly authorized. Synthetic text only, no audio/Redis.
import OpenAI from "openai";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import {
  openAiNotesPayload,
  lunaCostMicros,
} from "../src/lib/notes/provider-payload";
import { acceptNotesCompletion } from "../src/lib/notes/completion";
import type { NotesOutput, NotesRequest } from "../src/lib/shared/processing";
process.loadEnvFile(".env");
const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  baseURL: "https://api.openai.com/v1",
  timeout: 75000,
  maxRetries: 0,
});
let stage = "model-discovery";
try {
  const model = await client.models.retrieve("gpt-6-luna");
  assert.equal(model.id, "gpt-6-luna");
  const input: NotesRequest = {
    jobId: crypto.randomUUID(),
    unitId: "openai-native-probe",
    mode: "notes",
    attempt: 0,
    title: "Dinamica: prova sintetica",
    subject: "Fisica",
    languagePolicy: "original",
    sources: [
      {
        id: "s0p0",
        text: "La seconda legge della dinamica è F = ma per massa costante. Con massa 2 kg e accelerazione 3 m/s², la risultante è 6 N, non 5 N.",
        uncertain: false,
      },
      {
        id: "s1p0",
        text: "Il lavoro di una forza costante è W = F s cos(θ). Per forza perpendicolare allo spostamento il lavoro è zero. Il valore di un coefficiente non si sente chiaramente.",
        uncertain: true,
      },
    ],
  };
  stage = "structured-response";
  const started = performance.now(),
    payload = openAiNotesPayload(input);
  const response = await client.responses.create(payload);
  const data = acceptNotesCompletion(
    input,
    response.status === "completed" ? "stop" : "length",
    response.output_text,
  ) as NotesOutput;
  assert.deepEqual(data.coveredSourceIds, ["s0p0", "s1p0"]);
  assert.deepEqual(data.uncertainties[0].sourceIds, ["s1p0"]);
  const report = {
    checkedAt: new Date().toISOString(),
    ok: true,
    evidence:
      "real direct paid OpenAI SDK Responses API; two synthetic physics text sources; not audio/mobile",
    modelDiscovered: model.id,
    modelReturned: response.model,
    reasoningRequested: payload.reasoning,
    reasoningReturned: response.reasoning,
    status: response.status,
    seconds: Math.round((performance.now() - started) / 100) / 10,
    structuredOutputs: true,
    coveredSources: data.coveredSourceIds.length,
    uncertaintyWarnings: data.uncertainties.length,
    usage: response.usage,
    calculatedCostUsd: response.usage
      ? lunaCostMicros(
          response.usage.input_tokens,
          response.usage.output_tokens,
          response.usage.input_tokens_details.cached_tokens,
        ) / 1e6
      : null,
    // Only this synthetic reply, never headers, key, response IDs or account IDs.
    syntheticResponse: JSON.parse(response.output_text),
  };
  await mkdir("docs", { recursive: true });
  await writeFile(
    "docs/openai-native-probe.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  const { syntheticResponse, ...summary } = report;
  console.log(JSON.stringify(summary, null, 2));
} catch (error) {
  const report = {
    ok: false,
    checkedAt: new Date().toISOString(),
    stage,
    status: error instanceof OpenAI.APIError ? (error.status ?? 0) : 0,
    code:
      error instanceof Error &&
      ["TimeoutError", "APIConnectionTimeoutError"].includes(error.name)
        ? "TIMEOUT_AMBIGUOUS"
        : "OPENAI_PROBE_FAILED",
  };
  await mkdir("docs", { recursive: true });
  await writeFile(
    "docs/openai-native-probe.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  console.error(JSON.stringify(report));
  process.exitCode = 1;
}
