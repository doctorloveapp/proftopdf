import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import {
  QUOTA_RESERVE_LUA,
  QUOTA_SETTLE_LUA,
  RATE_LIMIT_LUA,
} from "../src/lib/server/quota-scripts";
import { CACHE_RESULT_LUA } from "../src/lib/server/cache-script";

process.loadEnvFile(".env");
const endpoint = process.env.UPSTASH_REDIS_REST_URL,
  token = process.env.UPSTASH_REDIS_REST_TOKEN;
if (
  !endpoint ||
  !token ||
  !/^https:\/\/[a-zA-Z0-9-]+\.upstash\.io\/?$/.test(endpoint)
)
  throw new Error("Configurazione Redis non valida.");
const prefix = `proftopdf:diagnostics:${randomUUID()}`;
const touched = new Set<string>();
async function command(args: unknown[]) {
  const response = await fetch(endpoint!, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`Redis HTTP ${response.status}`);
  const payload = await response.json();
  if (payload.error) throw new Error("Redis ha rifiutato la verifica.");
  return payload.result;
}
const spec = [
  { resource: "tokens", windowMs: 60000, limit: 30, cost: 10 },
  { resource: "requests", windowMs: 60000, limit: 3, cost: 1 },
];
async function reserve(
  id: string,
  fingerprint = "same-content",
  group = "concurrent",
) {
  const keys = [
    `${prefix}:${group}:op:${id}`,
    `${prefix}:${group}:tokens`,
    `${prefix}:${group}:requests`,
  ];
  keys.forEach((key) => touched.add(key));
  const raw = await command([
    "EVAL",
    QUOTA_RESERVE_LUA,
    keys.length,
    ...keys,
    JSON.stringify(spec),
    "reserve",
    id,
    fingerprint,
  ]);
  return JSON.parse(raw);
}
async function main() {
  let report: Record<string, unknown>;
  try {
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, index) => reserve(String(index))),
    );
    const acquired = results.filter(
      (result) => result.kind === "acquired",
    ).length;
    if (
      acquired !== 3 ||
      results.filter((result) => result.kind === "denied").length !== 9
    )
      throw new Error("Budget concorrente non rispettato.");
    const duplicates = await Promise.all(
      Array.from({ length: 6 }, () =>
        reserve("one-operation", "same-content", "idempotent"),
      ),
    );
    if (
      duplicates.filter((result) => result.kind === "acquired").length !== 1 ||
      duplicates.filter((result) => result.kind === "duplicate").length !== 5
    )
      throw new Error("Idempotenza non rispettata.");
    if (
      (await reserve("one-operation", "changed-content", "idempotent")).kind !==
      "conflict"
    )
      throw new Error("Conflitto non rilevato.");
    const op = `${prefix}:idempotent:op:one-operation`;
    const settled = await command([
      "EVAL",
      QUOTA_SETTLE_LUA,
      1,
      op,
      "same-content",
      JSON.stringify({ tokens: 4, requests: 1 }),
    ]);
    if (settled !== "settled") throw new Error("Riconciliazione fallita.");
    const keys = [
      op,
      `${prefix}:idempotent:tokens`,
      `${prefix}:idempotent:requests`,
    ];
    const snapshot = JSON.parse(
      await command([
        "EVAL",
        QUOTA_RESERVE_LUA,
        3,
        ...keys,
        JSON.stringify(spec),
        "inspect",
        "",
        "",
      ]),
    );
    if (snapshot.windows[0].used !== 4 || snapshot.windows[0].reserved !== 0)
      throw new Error("Consumo effettivo non corretto.");
    const rateKey = `${prefix}:login`;
    touched.add(rateKey);
    const rate = await Promise.all(
      Array.from({ length: 6 }, () =>
        command([
          "EVAL",
          RATE_LIMIT_LUA,
          1,
          rateKey,
          JSON.stringify([{ limit: 2, windowMs: 60000 }]),
          randomUUID(),
        ]),
      ),
    );
    if (rate.filter((value) => value === 0).length !== 2)
      throw new Error("Rate limit non atomico.");
    const cacheIndex = `${prefix}:cache:index`,
      cacheKey = `${prefix}:cache:result`,
      deniedCacheKey = `${prefix}:cache:denied`;
    [cacheIndex, cacheKey, deniedCacheKey].forEach((key) => touched.add(key));
    const nowSeconds = Math.floor(Date.now() / 1000);
    const members = Array.from({ length: 500 }, (_, index) => [
      nowSeconds,
      index === 0 ? cacheKey : `${prefix}:cache:placeholder:${index}`,
    ]).flat();
    await command(["ZADD", cacheIndex, ...members]);
    if (
      (await command([
        "EVAL",
        CACHE_RESULT_LUA,
        2,
        cacheIndex,
        deniedCacheKey,
        '{"synthetic":true}',
      ])) !== 0
    )
      throw new Error("Limite cache non rispettato.");
    if (
      (await command([
        "EVAL",
        CACHE_RESULT_LUA,
        2,
        cacheIndex,
        cacheKey,
        '{"synthetic":true}',
      ])) !== 1
    )
      throw new Error("Aggiornamento cache fallito.");
    const cacheTtl = await command(["TTL", cacheKey]);
    if (cacheTtl <= 0 || cacheTtl > 900)
      throw new Error("Scadenza cache non valida.");
    report = {
      checkedAt: new Date().toISOString(),
      ok: true,
      concurrentRequests: 12,
      acquired: 3,
      denied: 9,
      duplicateRequests: 6,
      duplicateAcquisitions: 1,
      conflictDetected: true,
      reconciledTokens: 4,
      loginConcurrentRequests: 6,
      loginAllowed: 2,
      groqCalls: 0,
      cacheCapacityEnforced: true,
      cacheTtlSeconds: cacheTtl,
    };
  } finally {
    if (touched.size) await command(["DEL", ...touched]);
  }
  await mkdir("docs", { recursive: true });
  await writeFile(
    "docs/atomic-quota-check.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report, null, 2));
}
main().catch(() => {
  console.error(
    "Verifica atomica non completata. Credenziali e dettagli delle richieste non visualizzati.",
  );
  process.exitCode = 1;
});
