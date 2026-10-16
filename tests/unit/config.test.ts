import assert from "node:assert/strict";
import { test } from "node:test";
import { parseServerConfig } from "../../src/lib/server/config-schema";

const origin = { APP_ORIGIN: "https://proftopdf.velodent.eu" };
const valid = {
  ...origin,
  AI_ENABLED: "true",
  GROQ_API_KEY: "synthetic-groq-key",
  UPSTASH_REDIS_REST_URL: "https://synthetic-database.upstash.io",
  UPSTASH_REDIS_REST_TOKEN: "synthetic-redis-token",
  SESSION_SECRET: "synthetic-session-secret-for-testing-only",
  APP_ACCESS_PASSWORD: "synthetic-password",
};

test("Production origin and confirmed model defaults are accepted", () => {
  const config = parseServerConfig(valid);
  assert.equal(config.AI_ENABLED, true);
  assert.equal(config.GROQ_STT_MODEL, "whisper-large-v3-turbo");
  assert.equal(config.GROQ_NOTES_MODEL, "openai/gpt-oss-120b");
  assert.equal(config.MAX_CHUNK_BYTES, 3_200_000);
});

test("AI is disabled by default and does not coerce false to true", () => {
  assert.equal(parseServerConfig(origin).AI_ENABLED, false);
  assert.equal(
    parseServerConfig({ ...origin, AI_ENABLED: "false" }).AI_ENABLED,
    false,
  );
  assert.throws(() => parseServerConfig({ ...origin, AI_ENABLED: "1" }));
});

test("Enabled AI requires all private configuration", () => {
  assert.throws(() => parseServerConfig({ ...origin, AI_ENABLED: "true" }));
});

test("Secrets never appear in configuration validation errors", () => {
  const secret = "never-include-this-private-value";
  assert.throws(
    () => parseServerConfig({ ...valid, UPSTASH_REDIS_REST_URL: secret }),
    (error: unknown) => {
      assert(error instanceof Error);
      assert(!error.message.includes(secret));
      assert(error.message.includes("UPSTASH_REDIS_REST_URL"));
      return true;
    },
  );
});

test("Origin rejects HTTP, paths and credentials", () => {
  for (const APP_ORIGIN of [
    "http://proftopdf.velodent.eu",
    "https://proftopdf.velodent.eu/path",
    "https://user:password@proftopdf.velodent.eu",
  ]) {
    assert.throws(() => parseServerConfig({ ...origin, APP_ORIGIN }));
  }
});

test("Redis rejects non-Upstash destinations and endpoint credentials", () => {
  for (const UPSTASH_REDIS_REST_URL of [
    "https://upstash.io.attacker.test",
    "http://test.upstash.io",
    "https://user:password@test.upstash.io",
    "https://test.upstash.io/?token=secret",
  ]) {
    assert.throws(() =>
      parseServerConfig({ ...valid, UPSTASH_REDIS_REST_URL }),
    );
  }
});

test("Unknown models and increased free-tier budgets are rejected", () => {
  assert.throws(() =>
    parseServerConfig({ ...valid, GROQ_NOTES_MODEL: "unapproved-model" }),
  );
  assert.throws(() =>
    parseServerConfig({ ...valid, LLM_TOKENS_PER_MINUTE: "8001" }),
  );
  assert.throws(() =>
    parseServerConfig({ ...valid, STT_AUDIO_SECONDS_PER_HOUR: "7201" }),
  );
});

test("Request body limit reserves room for multipart metadata", () => {
  assert.throws(() =>
    parseServerConfig({ ...valid, MAX_REQUEST_BYTES: "3200000" }),
  );
  assert.throws(() =>
    parseServerConfig({ ...valid, MAX_CHUNK_BYTES: "4500000" }),
  );
});

test("The configured password preserves whitespace exactly", () => {
  assert.equal(
    parseServerConfig({ ...valid, APP_ACCESS_PASSWORD: " keep this exactly " })
      .APP_ACCESS_PASSWORD,
    " keep this exactly ",
  );
});
