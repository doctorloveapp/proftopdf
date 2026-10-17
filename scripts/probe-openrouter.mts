// Feasibility only: no app/config edits, Groq calls, Redis writes or real audio.
// Explicit zero-priced :free models, no paid tools, no automatic HTTP retries.
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { buildNotesRequest } from "../src/lib/notes/prompt";
import { acceptNotesCompletion } from "../src/lib/notes/completion";
import { sourceMapContract } from "../src/lib/notes/source-contract";
import { RouteError } from "../src/lib/server/http-core";
import type { NotesRequest, NotesOutput } from "../src/lib/shared/processing";

const folder = "docs/openrouter";
const origin = "https://openrouter.ai/api/v1";
// A stuck socket/body must not keep a study probe alive indefinitely.
const processDeadline = setTimeout(() => {
  console.error("PROBE_PROCESS_DEADLINE_110S");
  process.exit(1);
}, 110_000);
processDeadline.unref();
process.loadEnvFile(".env");
const credential = process.env.OPENROUTER_API_KEY;
if (!credential) {
  console.error("OPENROUTER_KEY_MISSING");
  process.exit(1);
}
await mkdir(folder, { recursive: true });
const headers = {
  Authorization: `Bearer ${credential}`,
  "Content-Type": "application/json",
};
async function fetchJson(path: string, body?: unknown, timeout = 20_000) {
  const started = performance.now();
  const response = await fetch(`${origin}${path}`, {
    method: body ? "POST" : "GET",
    headers,
    redirect: "error",
    signal: AbortSignal.timeout(timeout),
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json();
  const rateHeaders = Object.fromEntries(
    [
      "retry-after",
      "x-ratelimit-limit",
      "x-ratelimit-remaining",
      "x-ratelimit-reset",
    ]
      .map((key) => [key, response.headers.get(key)])
      .filter(([, value]) => value !== null),
  );
  return {
    status: response.status,
    data,
    seconds: Math.round((performance.now() - started) / 100) / 10,
    rateHeaders,
  };
}
function keySummary(data: any) {
  const d = data?.data ?? {};
  // No key label, key hash, account identifier, credential or monetary balance.
  return {
    isFreeTier: d.is_free_tier ?? null,
    freeModelDailyRequests: d.free_model_daily_requests ?? null,
    dailyUsageUsd: d.usage_daily ?? null,
  };
}
function safeFailure(data: any) {
  const e = data?.error ?? {};
  const rawMessage = typeof e.message === "string" ? e.message : "";
  const categories = [
    "rate",
    "limit",
    "provider",
    "endpoint",
    "data policy",
    "privacy",
    "structured",
    "json",
    "credit",
    "schema",
    "unavailable",
    "moderation",
    "parameters",
  ];
  return {
    code: typeof e.code === "number" ? e.code : "API_ERROR",
    message: rawMessage
      .replaceAll(credential!, "[REDACTED]")
      .replace(/sk-[A-Za-z0-9_-]{12,}/g, "[REDACTED]")
      .slice(0, 500),
    categories: categories.filter((word) =>
      rawMessage.toLowerCase().includes(word),
    ),
    providerCode:
      typeof e.metadata?.provider_code === "number"
        ? e.metadata.provider_code
        : null,
  };
}
async function productionFiles() {
  const result: Record<string, string> = {};
  const hash = async (path: string) => {
    result[path.replaceAll("\\", "/")] = createHash("sha256")
      .update(await readFile(path))
      .digest("hex");
  };
  async function walk(dir: string) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) await hash(path);
    }
  }
  for (const dir of ["src", "config", "public"]) await walk(dir);
  for (const file of [
    "package.json",
    "package-lock.json",
    "next.config.ts",
    "next-env.d.ts",
    "postcss.config.mjs",
    "tsconfig.json",
    ".gitignore",
    "README.md",
    "AGENTS.md",
  ])
    await hash(file);
  return result;
}
async function save(name: string, value: unknown) {
  await writeFile(
    `${folder}/${name}.json`,
    JSON.stringify(value, null, 2) + "\n",
  );
}
const command = process.argv[2] ?? "discover";
const option = (name: string, fallback = "") =>
  process.argv
    .find((value) => value.startsWith(`--${name}=`))
    ?.slice(name.length + 3) ?? fallback;
try {
  if (command === "discover") {
    const baseline = `${folder}/production-before.json`;
    try {
      await readFile(baseline);
    } catch {
      await save("production-before", await productionFiles());
    }
    const results = await Promise.allSettled([
      fetchJson("/models"),
      fetchJson("/key"),
    ]);
    for (const result of results)
      if (result.status === "rejected") throw new Error("DISCOVERY_NETWORK");
    const models = (results[0] as PromiseFulfilledResult<any>).value;
    const key = (results[1] as PromiseFulfilledResult<any>).value;
    if (models.status !== 200 || key.status !== 200)
      throw new Error("DISCOVERY_AUTH_OR_API");
    const freeModels = models.data.data
      .filter((model: any) => model.id.endsWith(":free"))
      .map((model: any) => ({
        id: model.id,
        name: model.name,
        contextLength: model.context_length,
        pricing: model.pricing,
        topProvider: model.top_provider,
        supportedParameters: model.supported_parameters,
        perRequestLimits: model.per_request_limits,
        description: model.description,
      }));
    const report = {
      checkedAt: new Date().toISOString(),
      modelsHttp: models.status,
      keyHttp: key.status,
      totalModels: models.data.data.length,
      freeModelCount: freeModels.length,
      account: keySummary(key.data),
      requestedLegacyExamples: [
        "meta-llama/llama-3.3-70b-instruct:free",
        "google/gemini-2.0-flash-exp:free",
        "qwen/qwen-2.5-72b-instruct:free",
      ].map((id) => ({
        id,
        found: freeModels.some((model: any) => model.id === id),
      })),
      freeModels,
    };
    await save("discovery", report);
    console.log(
      JSON.stringify(
        {
          ...report,
          freeModels: freeModels.map(({ description, ...model }: any) => model),
        },
        null,
        2,
      ),
    );
  } else if (command === "estimate-luna") {
    const catalog = JSON.parse(
      await readFile(`${folder}/paid-discovery.json`, "utf8"),
    );
    const model = catalog.models.find((m: any) => m.id === "openai/gpt-6-luna");
    if (!model) throw new Error("MODEL_REJECTED");
    const inputPrice = Number(model.pricing.prompt),
      outputPrice = Number(model.pricing.completion);
    const usdPerEur = 1.1253;
    const scenarios = [
      { name: "efficient", inputTokens: 20000, outputTokens: 10000 },
      { name: "normal", inputTokens: 40000, outputTokens: 25000 },
      { name: "conservative", inputTokens: 80000, outputTokens: 50000 },
    ].map((scenario) => {
      const usd =
        scenario.inputTokens * inputPrice + scenario.outputTokens * outputPrice;
      return {
        ...scenario,
        usd: Number(usd.toFixed(6)),
        eur: Number((usd / usdPerEur).toFixed(6)),
      };
    });
    const report = {
      checkedAt: new Date().toISOString(),
      model: model.id,
      evidence: "local arithmetic using live catalog prices; no paid inference",
      pricesPerMillionUsd: {
        input: Number((inputPrice * 1e6).toFixed(6)),
        output: Number((outputPrice * 1e6).toFixed(6)),
      },
      exchange: {
        usdPerEur,
        date: "2026-10-16",
        source:
          "https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/index.en.html",
        indicativeOnly: true,
      },
      assumptions:
        "70-minute lecture; all calls including outline; uncached input; output includes any reasoning; no tools, no audio charge, below 272000 input tokens per request; excludes taxes/top-up/FX fees and unbounded retries",
      scenarios,
      suggestedPlanningRangeEur: [0.01, 0.05],
      lessonsForFiveEuroNetCreditAtPlanningRange: [100, 500],
      exampleFiveUsdCreditPurchase: {
        creditUsd: 5,
        feeUsd: 0.8,
        beforeTaxTotalUsd: 5.8,
        beforeTaxTotalEur: Number((5.8 / usdPerEur).toFixed(4)),
      },
    };
    await save("luna-cost-estimate", report);
    console.log(JSON.stringify(report, null, 2));
  } else if (command === "paid-discovery") {
    // User requested a pricing study only. This branch NEVER sends inference.
    const result = await fetchJson("/models");
    if (result.status !== 200) throw new Error("DISCOVERY_AUTH_OR_API");
    const models = result.data.data
      .filter(
        (model: any) =>
          model.id.startsWith("openai/") && /luna/i.test(model.id + model.name),
      )
      .map((model: any) => ({
        id: model.id,
        name: model.name,
        contextLength: model.context_length,
        pricing: model.pricing,
        topProvider: model.top_provider,
        supportedParameters: model.supported_parameters,
      }));
    const report = {
      checkedAt: new Date().toISOString(),
      status: result.status,
      evidence: "catalog metadata only; no paid inference or purchase",
      models,
    };
    await save("paid-discovery", report);
    console.log(JSON.stringify(report, null, 2));
  } else if (command === "summarize") {
    const names = (await readdir(folder)).filter(
      (name) => name.startsWith("probe-") && name.endsWith(".json"),
    );
    const reports = await Promise.all(
      names.map(async (name) => ({
        file: name,
        ...JSON.parse(await readFile(`${folder}/${name}`, "utf8")),
      })),
    );
    const aggregate = {
      checkedAt: new Date().toISOString(),
      attempts: reports.length,
      http200: reports.filter((p) => p.status === 200).length,
      applicationValid: reports.filter((p) => p.applicationValid).length,
      httpRejected: reports.filter(
        (p) => typeof p.status === "number" && p.status !== 200,
      ).length,
      ambiguous: reports.filter((p) => p.status === null).length,
      confirmedResponseTokens: reports.reduce(
        (sum, p) => sum + (p.usage?.total_tokens ?? 0),
        0,
      ),
      confirmedCostUsd: reports.reduce(
        (sum, p) => sum + (p.usage?.cost ?? 0),
        0,
      ),
      rows: reports.map(({ syntheticResponse, ...data }) => data),
    };
    await save("summary", aggregate);
    const { rows, ...summary } = aggregate;
    console.log(JSON.stringify(summary, null, 2));
  } else if (command === "account") {
    const result = await fetchJson("/key");
    if (result.status !== 200) throw new Error("KEY_CHECK_FAILED");
    const report = {
      checkedAt: new Date().toISOString(),
      status: result.status,
      account: keySummary(result.data),
    };
    await save("account-final", report);
    console.log(JSON.stringify(report, null, 2));
  } else if (command === "verify-files") {
    const before = JSON.parse(
      await readFile(`${folder}/production-before.json`, "utf8"),
    );
    const after = await productionFiles();
    const changed = [
      ...new Set([...Object.keys(before), ...Object.keys(after)]),
    ].filter((path) => before[path] !== after[path]);
    const result = {
      checkedAt: new Date().toISOString(),
      filesChecked: Object.keys(after).length,
      unchanged: changed.length === 0,
      changed,
    };
    await save("production-integrity", result);
    console.log(JSON.stringify(result));
    if (changed.length) process.exitCode = 1;
  } else if (command === "endpoints") {
    const model = option("model");
    if (!/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._:-]+:free$/.test(model))
      throw new Error("MODEL_REJECTED");
    const r = await fetchJson(`/models/${model}/endpoints`);
    const report = {
      model,
      checkedAt: new Date().toISOString(),
      status: r.status,
      ...(r.status === 200
        ? { endpoints: r.data.data }
        : { error: safeFailure(r.data) }),
    };
    await save(`endpoints-${model.replaceAll(/[/:]/g, "-")}`, report);
    console.log(JSON.stringify(report, null, 2));
  } else if (command === "probe") {
    const modelId = option("model"),
      mode = option("mode", "strict"),
      size = option("size", "small");
    if (
      !["strict", "prompt"].includes(mode) ||
      !["small", "dense", "large", "outline", "languages"].includes(size)
    )
      throw new Error("PROBE_ARGUMENTS");
    const catalog = await fetchJson("/models");
    const model = catalog.data?.data?.find((m: any) => m.id === modelId);
    if (
      !model ||
      !modelId.endsWith(":free") ||
      Number(model.pricing?.prompt) !== 0 ||
      Number(model.pricing?.completion) !== 0 ||
      Number(model.pricing?.request ?? 0) !== 0
    )
      throw new Error("NON_FREE_OR_UNKNOWN_MODEL_REJECTED");
    const keyBefore = await fetchJson("/key");
    if (keyBefore.status !== 200) throw new Error("KEY_CHECK_FAILED");
    const remaining = keySummary(keyBefore.data).freeModelDailyRequests
      ?.remaining;
    if (typeof remaining === "number" && remaining < 10)
      throw new Error("PRESERVE_PRODUCTION_REQUEST_BUDGET");
    const passages = [
      "La seconda legge della dinamica è F = ma per massa costante. La forza risultante è la somma vettoriale delle forze; l'accelerazione ha la sua direzione.",
      "Lavoro di una forza costante: W = F s cos(θ). Quando forza e spostamento sono perpendicolari, il lavoro è zero anche se la forza non è nulla.",
      "L'energia cinetica è K = mv²/2. Il teorema delle forze vive lega il lavoro della risultante alla variazione di energia cinetica.",
      "Se agiscono solo forze conservative, l'energia meccanica si conserva. L'attrito può trasformarla in energia interna, senza violare la conservazione dell'energia totale.",
      "La quantità di moto è p = mv. In un sistema isolato si conserva la quantità di moto totale; negli urti anelastici non si conserva in generale l'energia cinetica.",
      "L'azione e la reazione hanno uguale intensità e verso opposto, ma agiscono su corpi diversi: non si annullano nel diagramma di un singolo corpo.",
      "La pressione è forza normale divisa per area, p = F/A, e si misura in pascal. La massa si misura in chilogrammi e non coincide con il peso mg.",
      "Per un gas ideale vale pV = nRT con temperatura in kelvin. È un modello che trascura volume proprio delle particelle e interazioni a distanza.",
      "La velocità è vettoriale. Nel moto circolare uniforme cambia direzione anche se il modulo resta costante, perciò è presente accelerazione centripeta.",
      "La potenza media è il lavoro diviso per l'intervallo di tempo, P = W/Δt. Si misura in watt, equivalenti a joule al secondo.",
      "Il professore corregge un esempio: con massa di 2 kg e accelerazione di 3 m/s² la forza risultante vale 6 N, non 5 N.",
      "La trascrizione è incerta sul valore di un coefficiente. Non inventare quel valore: segnala il dubbio e conserva solo il rapporto qualitativo discusso.",
    ];
    const count =
      size === "small"
        ? 2
        : size === "dense"
          ? 12
          : size === "large"
            ? 30
            : size === "outline"
              ? 8
              : 4;
    const languageTexts = [
      "In italiano distinguiamo distanza e spostamento.",
      "The present perfect connects a past action to the present: I have lost my keys. Do not translate this example.",
      "La docente cita il latino: rosa, rosae; carpe diem. Conservare i termini latini senza tradurli automaticamente.",
      "Il greco antico scolastico distingue λόγος e ἄνθρωπος; mantenere accenti e spiriti nella citazione.",
    ];
    const sources = Array.from({ length: count }, (_, index) => ({
      id: `s${index}p0`,
      text:
        size === "outline"
          ? `Argomento ${index + 1}: ${["Forze", "Lavoro", "Energia", "Urti"][Math.floor(index / 2)]}`
          : size === "languages"
            ? languageTexts[index]
            : Array.from(
                { length: size === "large" ? 4 : 1 },
                () => passages[index % passages.length],
              ).join(" "),
      uncertain: size !== "outline" && index === count - 1,
    }));
    const faithful = option("guidance") === "faithful";
    const input: NotesRequest = {
      jobId: crypto.randomUUID(),
      unitId: "openrouter-synthetic",
      mode: size === "outline" ? "outline" : "notes",
      attempt: 0,
      title: "Lezione sintetica per fattibilità",
      subject:
        size === "languages"
          ? faithful
            ? "Inglese"
            : "Inglese, Latino e Greco"
          : "Fisica",
      languagePolicy: "original",
      sources,
    };
    const payload = buildNotesRequest(input);
    const maxTokens = Number(
      option("max-output", String(size === "large" ? 6000 : payload.maxOutput)),
    );
    if (!Number.isSafeInteger(maxTokens) || maxTokens < 500 || maxTokens > 8000)
      throw new Error("PROBE_ARGUMENTS");
    const reasoning = option("reasoning", "default");
    if (!["default", "off", "low"].includes(reasoning))
      throw new Error("PROBE_ARGUMENTS");
    const resultName = `probe-${modelId.replaceAll(/[/:]/g, "-")}-${mode}-${size}-${option("privacy", "default")}${reasoning === "default" ? "" : `-reasoning-${reasoning}`}${option("max-output") ? `-output-${maxTokens}` : ""}${faithful ? "-faithful" : ""}`;
    const messages =
      mode === "prompt"
        ? payload.messages.map((message, i) =>
            i === 0
              ? {
                  ...message,
                  content:
                    message.content +
                    " Rispondi esclusivamente con JSON conforme a questo schema, senza blocchi Markdown: " +
                    JSON.stringify(payload.response_format.json_schema.schema),
                }
              : message,
          )
        : payload.messages;
    if (faithful)
      messages[0] = {
        ...messages[0],
        content:
          messages[0].content +
          " Vincoli di fedeltà aggiuntivi: ogni voce sourceNotes riassume solo ciò che la propria fonte afferma esplicitamente. Se la fonte è in inglese, TUTTI i suoi paragrafi, elenchi e concetti devono essere in inglese; non sostituire la spiegazione inglese con una italiana. Una citazione latina o greca può restare nel contesto italiano, ma senza aggiungere traduzioni, etimologie, analisi grammaticali, significati o definizioni non detti dalla fonte. Se un termine non è definito esplicitamente, non includerlo nel glossario. Lascia vuoti gli array inutili; non duplicare la stessa frase in paragraphs e bullets. Scrivi formule in semplice testo Unicode: niente dollari, LaTeX o comandi come text. Non trasformare istruzioni sulla trascrizione in fatti della lezione. Non inventare valori o dettagli.",
      };
    const requestBody = {
      model: modelId,
      messages,
      max_tokens: maxTokens,
      stream: false,
      ...(reasoning === "off"
        ? { reasoning: { enabled: false } }
        : reasoning === "low"
          ? { reasoning: { effort: "low" } }
          : {}),
      ...(mode === "strict"
        ? { response_format: payload.response_format }
        : {}),
      provider: {
        require_parameters: true,
        max_price: { prompt: 0, completion: 0, request: 0 },
        ...(option("privacy") === "deny" ? { data_collection: "deny" } : {}),
      },
    };
    let result: Awaited<ReturnType<typeof fetchJson>>;
    const probeStarted = performance.now();
    try {
      result = await fetchJson("/chat/completions", requestBody, 75_000);
    } catch (error) {
      const timed = {
        checkedAt: new Date().toISOString(),
        modelRequested: modelId,
        mode,
        size,
        sourceCount: count,
        syntheticOnly: true,
        reasoning,
        maxOutputTokens: maxTokens,
        status: null,
        seconds: Math.round((performance.now() - probeStarted) / 100) / 10,
        applicationValid: false,
        error:
          error instanceof Error && error.name === "TimeoutError"
            ? "TIMEOUT_75_SECONDS_AMBIGUOUS"
            : "NETWORK_AMBIGUOUS",
        noAutomaticRetry: true,
      };
      await save(resultName, timed);
      console.log(JSON.stringify(timed, null, 2));
      process.exitCode = 1;
      throw new Error("AMBIGUOUS_PROBE_STOP");
    }
    const safe: any = {
      checkedAt: new Date().toISOString(),
      modelRequested: modelId,
      mode,
      size,
      sourceCount: count,
      syntheticOnly: true,
      productionRequestSchemaFits:
        Buffer.byteLength(JSON.stringify(input), "utf8") <= 16000,
      requestJsonBytes: Buffer.byteLength(JSON.stringify(input), "utf8"),
      sourceCharacters: sources.reduce(
        (sum, source) => sum + source.text.length,
        0,
      ),
      maxOutputTokens: maxTokens,
      reasoning,
      guidance: faithful
        ? "reinforced-synthetic-proposal"
        : "current-production-prompt",
      privacy: option("privacy", "account-default"),
      status: result.status,
      seconds: result.seconds,
      rateHeaders: result.rateHeaders,
      applicationValid: false,
    };
    if (result.status === 200 && !result.data.error) {
      const choice = result.data.choices?.[0];
      safe.modelReturned = result.data.model;
      safe.provider = result.data.provider;
      safe.finishReason = choice?.finish_reason;
      safe.usage = result.data.usage;
      // Store only the synthetic answer, never raw request headers or credentials.
      safe.syntheticResponse = choice?.message?.content ?? null;
      try {
        const accepted = acceptNotesCompletion(
          input,
          choice?.finish_reason,
          choice?.message?.content,
        );
        if (input.mode === "notes")
          sourceMapContract(input).parse(
            JSON.parse(choice?.message?.content ?? ""),
          );
        safe.applicationValid = true;
        if (input.mode === "notes") {
          const notes = accepted as NotesOutput;
          safe.validation = {
            covered: notes.coveredSourceIds.length,
            sections: notes.sections.length,
            uncertaintyWarnings: notes.uncertainties.length,
            glossary: notes.glossary.length,
          };
        } else
          safe.validation = { chapters: (accepted as any).chapters.length };
      } catch (error) {
        safe.validationError =
          error instanceof RouteError
            ? { code: error.code, diagnostics: error.diagnostics }
            : { code: "JSON_OR_SOURCE_SCHEMA" };
      }
      if (Number(result.data.usage?.cost ?? 0) !== 0)
        throw new Error("NONZERO_COST_STOP");
    } else safe.error = safeFailure(result.data);
    const keyAfter = await fetchJson("/key");
    safe.accountBefore = keySummary(keyBefore.data);
    safe.accountAfter = keySummary(keyAfter.data);
    await save(resultName, safe);
    const { syntheticResponse, ...summary } = safe;
    console.log(JSON.stringify(summary, null, 2));
  } else throw new Error("UNKNOWN_COMMAND");
} catch (error) {
  const allowed = [
    "DISCOVERY_NETWORK",
    "DISCOVERY_AUTH_OR_API",
    "MODEL_REJECTED",
    "PROBE_ARGUMENTS",
    "NON_FREE_OR_UNKNOWN_MODEL_REJECTED",
    "KEY_CHECK_FAILED",
    "PRESERVE_PRODUCTION_REQUEST_BUDGET",
    "NONZERO_COST_STOP",
    "UNKNOWN_COMMAND",
    "AMBIGUOUS_PROBE_STOP",
  ];
  console.error(
    JSON.stringify({
      failure:
        error instanceof Error && allowed.includes(error.message)
          ? error.message
          : "NETWORK_TIMEOUT_OR_LOCAL_CHECK",
      name:
        error instanceof Error &&
        ["TimeoutError", "AbortError"].includes(error.name)
          ? error.name
          : "ProbeError",
    }),
  );
  process.exitCode = 1;
}
