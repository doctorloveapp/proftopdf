// Real Redis only; synthetic job keys, no inference, no shared quota resets.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { getRedis } from "../src/lib/server/redis";
import { claimRoute } from "../src/lib/server/llm/state";
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
  const next = await claimRoute(id, "synthetic-fingerprint", tombstone, index);
  assert.equal(next.state.index, 1);
  await assert.rejects(
    () => claimRoute(id, "changed-fingerprint", tombstone, index),
    { code: "IDEMPOTENCY_CONFLICT" },
  );
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
