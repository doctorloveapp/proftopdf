// Real Redis only; synthetic job keys, no inference, no shared quota resets.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { getRedis } from "../src/lib/server/redis";
import { claimRoute } from "../src/lib/server/llm/state";
import {
  runCascade,
  LLM_POLICY_REVISION,
} from "../src/lib/server/llm/cascade-core";
import { createRequire } from "node:module";
// Use the same tsx/CJS class identity as cascade-core in this isolated .mts
// runner. Production bundling and the unit suite have a single module graph.
const { RouteError } = createRequire(import.meta.url)(
  "../src/lib/server/http-core.ts",
);
process.loadEnvFile(".env");
const id = `lock-probe-${crypto.randomUUID()}`;
const key = `proftopdf:v2:llm-route:${id}`;
const tombstone = `proftopdf:v2:test:${id}:deleted`;
const index = `proftopdf:v2:test:${id}:index`;
const redis = getRedis();
let stage = "parallel-claims";
try {
  const claims = await Promise.allSettled(
    Array.from({ length: 12 }, () =>
      claimRoute(id, "synthetic-fingerprint", tombstone, index),
    ),
  );
  const winners = claims.filter((r) => r.status === "fulfilled");
  assert.equal(winners.length, 1);
  assert(
    claims
      .filter((r) => r.status === "rejected")
      .every((r) => r.reason?.code === "RESULT_UNCERTAIN"),
  );
  const route = winners[0].value;
  stage = "empty-state-arrays";
  assert(Array.isArray(route.state.usage));
  assert(Array.isArray(route.state.failures));
  route.state.index = 1;
  await route.save(route.state);
  await route.release(route.state);
  stage = "persisted-routing";
  let next = await claimRoute(id, "synthetic-fingerprint", tombstone, index);
  assert.equal(next.state.index, 1);
  assert.equal(next.state.policy, LLM_POLICY_REVISION);
  await assert.rejects(
    () => claimRoute(id, "changed-fingerprint", tombstone, index),
    { code: "IDEMPOTENCY_CONFLICT" },
  );
  stage = "short-groq-wait-survives-release";
  await assert.rejects(
    () =>
      runCascade({
        state: next.state,
        save: next.save,
        cache: async () => {
          throw new Error("No successful result expected");
        },
        execute: async (provider) => {
          assert.equal(provider, "groq");
          throw new RouteError(
            429,
            "PROVIDER_RATE_LIMIT",
            "Synthetic rejection",
            new Date(Date.now() + 90_000).toISOString(),
            {
              stage: "quota",
              issueCount: 0,
              issues: [],
              usage: {
                reservedTokens: 10,
                confirmedTokens: 0,
                costMicroUsd: 0,
              },
            },
          );
        },
      }),
    { code: "LLM_QUOTA" },
  );
  await next.release(next.state);
  next = await claimRoute(id, "synthetic-fingerprint", tombstone, index);
  assert.equal(next.state.index, 1);
  assert.equal(next.state.groqLeg, 1);
  assert.equal(next.state.usage.length, 1);
  stage = "ambiguous-call-remains-locked";
  await next.started(next.state);
  // Simulate lease expiry, keeping the started flag. Expiry must NOT authorize
  // another inference after an upstream response has been lost.
  const record = await redis.get<Record<string, unknown>>(key);
  assert(record);
  record.leaseUntil = 0;
  await redis.set(key, JSON.stringify(record), { ex: 300 });
  await assert.rejects(
    () => claimRoute(id, "synthetic-fingerprint", tombstone, index),
    { code: "RESULT_UNCERTAIN" },
  );
  stage = "deletion-tombstone";
  await redis.set(tombstone, "1", { ex: 300 });
  await assert.rejects(() => next.save(next.state), { code: "JOB_DELETED" });
  await assert.rejects(
    () => claimRoute(id, "synthetic-fingerprint", tombstone, index),
    { code: "JOB_DELETED" },
  );
  const report = {
    checkedAt: new Date().toISOString(),
    ok: true,
    evidence: "real Redis, synthetic keys only; no inference/audio/deploy",
    simultaneousClaims: 12,
    successfulClaims: 1,
    stateSurvivesRelease: true,
    groqShortWaitPersisted: true,
    fingerprintConflictBlocked: true,
    expiredStartedLeaseBlocked: true,
    deletedJobBlocked: true,
  };
  await mkdir("docs", { recursive: true });
  await writeFile(
    "docs/llm-locks-live-check.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.error({ stage, code: "LOCK_CHECK_FAILED" });
  process.exitCode = 1;
} finally {
  await redis.del(key, tombstone, index).catch(() => {});
}
