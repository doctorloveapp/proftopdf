import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";

try {
  process.loadEnvFile(resolve(".env"));
} catch (error) {
  if (error.code !== "ENOENT")
    throw new Error("Impossibile caricare la configurazione locale.");
}

const required = [
  "GROQ_API_KEY",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
];
for (const name of required) {
  if (!process.env[name]) throw new Error(`Variabile mancante: ${name}`);
}

const report = {
  checkedAt: new Date().toISOString(),
  groq: {
    models: [],
    selectedStt: null,
    selectedNotes: null,
    strictProbe: null,
  },
  redis: { ping: null, atomicCounter: null },
};

async function timedRequest(url, options = {}) {
  const start = performance.now();
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok)
    throw new Error(`Richiesta diagnostica rifiutata: HTTP ${response.status}`);
  return {
    payload: await response.json(),
    elapsedMs: Math.round(performance.now() - start),
  };
}

async function checkGroq() {
  const headers = {
    Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
    "Content-Type": "application/json",
  };
  const { payload } = await timedRequest(
    "https://api.groq.com/openai/v1/models",
    { headers },
  );
  if (!Array.isArray(payload.data))
    throw new Error("Elenco modelli non valido.");
  report.groq.models = payload.data
    .filter((model) => model.active !== false)
    .map((model) => ({
      id: model.id,
      active: model.active ?? true,
      contextWindow: model.context_window ?? null,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const ids = new Set(report.groq.models.map((model) => model.id));
  report.groq.selectedStt =
    ["whisper-large-v3-turbo", "whisper-large-v3"].find((id) => ids.has(id)) ??
    null;
  // Only documented production models with strict structured outputs, not generic JSON mode.
  report.groq.selectedNotes =
    ["openai/gpt-oss-120b", "openai/gpt-oss-20b"].find((id) => ids.has(id)) ??
    null;
  if (!report.groq.selectedStt || !report.groq.selectedNotes)
    throw new Error("Nessuna coppia STT/LLM compatibile nella allowlist.");
  const probe = await timedRequest(
    "https://api.groq.com/openai/v1/chat/completions",
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: report.groq.selectedNotes,
        messages: [
          {
            role: "user",
            content:
              "Restituisci lo stato ok. Questa è una verifica tecnica sintetica.",
          },
        ],
        reasoning_effort: "low",
        max_completion_tokens: 256,
        stream: false,
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "infrastructure_probe",
            strict: true,
            schema: {
              type: "object",
              properties: { status: { type: "string", enum: ["ok"] } },
              required: ["status"],
              additionalProperties: false,
            },
          },
        },
      }),
    },
  );
  const choice = probe.payload.choices?.[0];
  const parsed = JSON.parse(choice?.message?.content ?? "null");
  if (
    choice?.finish_reason !== "stop" ||
    parsed?.status !== "ok" ||
    Object.keys(parsed).length !== 1
  ) {
    throw new Error("La verifica strict output non è stata completata.");
  }
  report.groq.strictProbe = {
    ok: true,
    elapsedMs: probe.elapsedMs,
    model: probe.payload.model,
    finishReason: choice.finish_reason,
    usage: probe.payload.usage
      ? {
          promptTokens: probe.payload.usage.prompt_tokens,
          completionTokens: probe.payload.usage.completion_tokens,
          totalTokens: probe.payload.usage.total_tokens,
        }
      : null,
  };
}

async function redisCommand(command) {
  const endpoint = new URL(process.env.UPSTASH_REDIS_REST_URL);
  if (
    endpoint.protocol !== "https:" ||
    !endpoint.hostname.endsWith(".upstash.io")
  ) {
    throw new Error("Endpoint Redis non consentito.");
  }
  const result = await timedRequest(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(command),
  });
  if (result.payload.error) throw new Error("Comando Redis rifiutato.");
  return { result: result.payload.result, elapsedMs: result.elapsedMs };
}

async function checkRedis() {
  const ping = await redisCommand(["PING"]);
  if (ping.result !== "PONG") throw new Error("Risposta PING Redis inattesa.");
  report.redis.ping = { ok: true, elapsedMs: ping.elapsedMs };
  const key = `proftopdf:diagnostics:${randomUUID()}`;
  try {
    const atomic = await redisCommand([
      "EVAL",
      'local a=redis.call("INCR",KEYS[1]); redis.call("EXPIRE",KEYS[1],30); local b=redis.call("INCR",KEYS[1]); return {a,b,redis.call("TTL",KEYS[1])}',
      1,
      key,
    ]);
    if (
      !Array.isArray(atomic.result) ||
      atomic.result[0] !== 1 ||
      atomic.result[1] !== 2 ||
      atomic.result[2] <= 0
    ) {
      throw new Error("Verifica del contatore atomico fallita.");
    }
    report.redis.atomicCounter = {
      ok: true,
      elapsedMs: atomic.elapsedMs,
      increments: [1, 2],
      ttlSeconds: atomic.result[2],
    };
  } finally {
    await redisCommand(["DEL", key]);
  }
}

const checks = await Promise.allSettled([checkGroq(), checkRedis()]);
for (const [index, check] of checks.entries()) {
  if (check.status === "rejected") {
    // Never serialize the original fetch/SDK error: it may include authenticated request details.
    const reason = check.reason;
    const code =
      reason?.cause?.code ?? reason?.code ?? reason?.name ?? "UNKNOWN";
    const safeCode = /^[A-Za-z0-9_]+$/.test(code) ? code : "UNKNOWN";
    const httpStatus = /HTTP (\d{3})/.exec(reason?.message ?? "")?.[1];
    report[index === 0 ? "groq" : "redis"].error =
      `Verifica non completata (${safeCode}${httpStatus ? `, HTTP ${httpStatus}` : ""}).`;
  }
}
await mkdir(resolve("docs"), { recursive: true });
await writeFile(
  resolve("docs/infrastructure-check.json"),
  `${JSON.stringify(report, null, 2)}\n`,
);
console.log(JSON.stringify(report, null, 2));
if (checks.some((check) => check.status === "rejected")) process.exitCode = 1;
