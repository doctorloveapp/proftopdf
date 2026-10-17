import { test } from "node:test";
import assert from "node:assert/strict";
import {
  freshCascade,
  runCascade,
  type CascadeDependencies,
} from "../../src/lib/server/llm/cascade-core";
import { RouteError } from "../../src/lib/server/http-core";
import {
  openAiNotesPayload,
  openRouterNotesPayload,
} from "../../src/lib/notes/provider-payload";
import { buildNotesRequest } from "../../src/lib/notes/prompt";
import { summarizeNotesUsage } from "../../src/lib/audio/diagnostics";
import { planNotes } from "../../src/lib/notes/batching";
import {
  emptyProcessing,
  type NotesOutput,
  type NotesRequest,
} from "../../src/lib/shared/processing";
import { mapProviderError } from "../../src/lib/server/llm/provider-errors";
import {
  performOperation,
  type OperationDependencies,
} from "../../src/lib/server/operation-core";
import { requestNotes } from "../../src/lib/client/notes";
import { confirmedFreeUsage } from "../../src/lib/server/llm/usage-core";

test("Free fallback usage requires explicit numeric zero cost; unknown or positive charges cannot pass as free", () => {
  assert.equal(confirmedFreeUsage({ total_tokens: 1200, cost: 0 }), 1200);
  for (const usage of [
    undefined,
    { total_tokens: 1200, cost: null },
    { total_tokens: 1200 },
    { total_tokens: 1200, cost: 0.001 },
    { total_tokens: 1200, cost: "0" },
    { total_tokens: -1, cost: 0 },
    { total_tokens: NaN, cost: 0 },
  ])
    assert.throws(() => confirmedFreeUsage(usage), {
      code: "USAGE_UNVERIFIED",
    });
});
const output: NotesOutput = {
  sections: [
    {
      title: "Dinamica",
      paragraphs: ["F = ma."],
      bullets: [],
      concepts: [],
      sourceIds: ["s0"],
    },
  ],
  glossary: [],
  uncertainties: [],
  coveredSourceIds: ["s0"],
};
const input: NotesRequest = {
  jobId: crypto.randomUUID(),
  unitId: "probe",
  mode: "notes",
  attempt: 0,
  title: "Fisica",
  subject: "Fisica",
  sources: [{ id: "s0", text: "F = ma.", uncertain: false }],
};
function fixture(execute: CascadeDependencies["execute"]) {
  const state = freshCascade(),
    saved: unknown[] = [],
    cached: unknown[] = [];
  const deps: CascadeDependencies = {
    state,
    execute,
    save: async (value) => {
      saved.push(structuredClone(value));
    },
    cache: async (value) => {
      cached.push(value);
    },
  };
  return { state, saved, cached, deps };
}
function rejected(code = "LLM_REJECTED") {
  return new RouteError(
    503,
    code,
    "Synthetic failure",
    new Date(Date.now() + 60000).toISOString(),
    {
      stage: "provider",
      issueCount: 0,
      issues: [],
      usage: { reservedTokens: 6000, confirmedTokens: 0, costMicroUsd: 0 },
    },
  );
}
test("Native OpenAI and OpenRouter share the exact schema; Luna uses requested reasoning and free fallback cannot bill", () => {
  const native = openAiNotesPayload(input),
    router = openRouterNotesPayload(input),
    common = buildNotesRequest(input);
  assert.equal(native.model, "gpt-6-luna");
  assert.deepEqual(native.reasoning, { mode: "standard", effort: "medium" });
  assert.deepEqual(
    native.text.format.schema,
    common.response_format.json_schema.schema,
  );
  assert.deepEqual(
    router.response_format.json_schema.schema,
    native.text.format.schema,
  );
  assert.equal(native.store, false);
  assert.deepEqual(router.reasoning, { enabled: false });
  assert.equal(router.provider.data_collection, "deny");
  assert.deepEqual(router.provider.max_price, {
    prompt: 0,
    completion: 0,
    request: 0,
  });
  assert(router.model.endsWith(":free"));
});
test("A successful primary never invokes either fallback", async () => {
  const calls: string[] = [];
  const f = fixture(async (provider) => {
    calls.push(provider);
    return {
      ...output,
      usage: {
        reservedTokens: 8000,
        confirmedTokens: 1000,
        provider,
        costMicroUsd: 200,
      },
    };
  });
  const result = await runCascade(f.deps);
  assert(!("state" in result));
  assert.deepEqual(calls, ["openai"]);
  assert.equal(f.cached.length, 1);
});
test("Definitive failures cascade over separate invocations, persisting before reroute and preserving usage", async () => {
  const calls: string[] = [];
  const f = fixture(async (provider) => {
    calls.push(provider);
    if (provider !== "groq") throw rejected();
    return {
      ...output,
      usage: {
        provider,
        reservedTokens: 5000,
        confirmedTokens: 1300,
        costMicroUsd: 0,
      },
    };
  });
  assert.deepEqual(await runCascade(f.deps), {
    state: "reroute",
    provider: "openrouter",
  });
  assert.equal(f.state.index, 1);
  assert.equal(f.saved.length, 1);
  assert.equal(calls.length, 1);
  assert.deepEqual(await runCascade(f.deps), {
    state: "reroute",
    provider: "groq",
  });
  const result = await runCascade(f.deps);
  assert(!("state" in result));
  assert.deepEqual(calls, ["openai", "openrouter", "groq"]);
  assert.equal(result.usage?.legs?.length, 3);
  assert.equal(result.usage?.confirmedTokens, 1300);
});
test("Ambiguous or invalid content cannot silently launch a second provider", async () => {
  for (const code of [
    "RESULT_UNCERTAIN",
    "NOTES_INVALID",
    "USAGE_UNVERIFIED",
  ]) {
    const calls: string[] = [];
    const f = fixture(async (provider) => {
      calls.push(provider);
      throw new RouteError(503, code, "Synthetic");
    });
    await assert.rejects(() => runCascade(f.deps), { code });
    assert.deepEqual(calls, ["openai"]);
    assert.equal(f.cached.length, 0);
  }
});
test("Locally denied providers skip without inference; all-denied waits do not consume retry rounds", async () => {
  const until = new Date(Date.now() + 3600000).toISOString();
  const f = fixture(async () => {
    throw new RouteError(429, "LLM_QUOTA", "Local quota", until);
  });
  for (let i = 0; i < 4; i++) {
    await assert.rejects(() => runCascade(f.deps), {
      code: "LLM_QUOTA",
      retryAt: until,
    });
    assert.equal(f.state.round, 0);
    assert.equal(f.state.index, 0);
  }
});
test("A large unit reaching Groq requests persisted rebatching rather than an oversized inference", async () => {
  const f = fixture(async (provider) => {
    if (provider !== "groq")
      throw new RouteError(503, "LLM_NOT_CONFIGURED", "Not configured");
    throw new RouteError(413, "TOKEN_BUDGET", "Rebatch");
  });
  assert.deepEqual(await runCascade(f.deps), {
    state: "rebatch",
    provider: "groq",
  });
  assert.equal(f.state.index, 2);
});

test("Rebatching preserves earlier provider usage instead of dropping it with the large parent", async () => {
  const f = fixture(async (provider) => {
    if (provider !== "groq") throw rejected();
    throw new RouteError(413, "TOKEN_BUDGET", "Rebatch");
  });
  await runCascade(f.deps);
  await runCascade(f.deps);
  const result = await runCascade(f.deps);
  assert("state" in result && result.state === "rebatch");
  assert.equal(result.usage?.legs?.length, 2);
  assert.equal(result.usage?.confirmedTokens, 0);
});
test("Ledger includes known fallback tokens even when an earlier provider has unknown consumption", () => {
  const summary = summarizeNotesUsage(
    {
      unit: {
        reservedTokens: 10000,
        confirmedTokens: null,
        legs: [
          {
            provider: "openai",
            reservedTokens: 7000,
            confirmedTokens: null,
            costMicroUsd: null,
          },
          {
            provider: "openrouter",
            reservedTokens: 3000,
            confirmedTokens: 1200,
            costMicroUsd: 0,
          },
        ],
      },
    },
    true,
  );
  assert.equal(summary.confirmedTokens, 1200);
  assert.equal(summary.reservedUnverifiedTokens, 7000);
  assert.equal(summary.costHistoryComplete, false);
});
test("Large primary batches retain every source and can repack untouched work to the unchanged Groq budget", async () => {
  const segments = Array.from({ length: 65 }, (_, i) => ({
    id: `s${i}`,
    chunkId: "c0",
    text: `Argomento ${i}: F = ma. `.repeat(12),
    startSeconds: i,
    endSeconds: i + 1,
    status: "confirmed" as const,
  }));
  const data = emptyProcessing();
  data.notesBudgetProfile = "large";
  const large = await planNotes(segments, data, input);
  data.notesPlan = large;
  assert(large.units.every((unit) => unit.sources.length <= 30));
  data.notes[large.units[0].id] = output;
  data.failedUnitId = `notes-${large.units[1].id}`;
  data.quotaBlockedUnitId = data.failedUnitId;
  data.notesBudgetProfile = "groq";
  const small = await planNotes(segments, data, input);
  assert.equal(small.units[0].id, large.units[0].id);
  assert.deepEqual(
    small.units.flatMap((unit) => unit.sources),
    large.units.flatMap((unit) => unit.sources),
  );
  for (const unit of small.units.slice(1))
    assert(
      buildNotesRequest({
        ...input,
        unitId: unit.id,
        sources: unit.sources,
        attempt: 2,
      }).tokenUpperBound <= 5500,
    );
});

test("Received credit/auth/rate/service failures may fail over; timeouts remain ambiguous and errors contain no raw details", () => {
  for (const status of [400, 401, 402, 403, 404, 429, 500, 502, 503, 504]) {
    const error = mapProviderError({
      status,
      message: "private-provider-details",
      headers: new Headers({ "retry-after": "5" }),
    });
    assert.equal(error.code, "LLM_REJECTED");
    assert(error.retryAt);
    assert(!error.message.includes("private-provider-details"));
    assert.equal(error.confirmedUsage, status < 500 ? 0 : undefined);
  }
  assert.equal(mapProviderError(new Error("timeout")).code, "RESULT_UNCERTAIN");
  const until = Date.parse(
    mapProviderError({ status: 429, code: "insufficient_quota" }).retryAt!,
  );
  assert(until >= Date.now() + 3599_000);
});

test("Definitive pre-generation rejection settles a zero charge and cached replay cannot start another inference", async () => {
  let cached: unknown = null,
    calls = 0;
  const settlements: number[] = [];
  const deps: OperationDependencies = {
    notesReservation: 9000,
    read: async () => cached as never,
    reserve: async () => ({ acquired: true, status: "reserved" }),
    cache: async (value) => {
      cached = value;
      return true;
    },
    settle: async (value) => {
      settlements.push(value);
    },
    providerError: async (error) => mapProviderError(error),
  };
  const invoke = async (): Promise<never> => {
    calls++;
    throw { status: 402 };
  };
  await assert.rejects(() => performOperation(deps, invoke), {
    code: "LLM_REJECTED",
  });
  await assert.rejects(() => performOperation(deps, invoke), {
    code: "LLM_REJECTED",
  });
  assert.equal(calls, 1);
  assert.deepEqual(settlements, [0]);
  assert.equal((cached as any).error.diagnostics.usage.confirmedTokens, 0);
});

test("Repeated definite provider failures stop after three rounds and account once per leg", async () => {
  const f = fixture(async () => {
    throw rejected();
  });
  for (let round = 0; round < 3; round++) {
    assert.equal(((await runCascade(f.deps)) as any).state, "reroute");
    assert.equal(((await runCascade(f.deps)) as any).state, "reroute");
    await assert.rejects(() => runCascade(f.deps), {
      code: round < 2 ? "LLM_QUOTA" : "LLM_UNAVAILABLE",
    });
  }
  assert.equal(f.state.usage.length, 9);
  assert.equal(f.state.round, 2);
});

test("Transparent 202 routing repeats the same operation and attempt without exposing provider credentials", async (t) => {
  t.mock.method(console, "info", () => {});
  const bodies: string[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: unknown, options: RequestInit) => {
      bodies.push(String(options.body));
      const data =
        bodies.length === 1
          ? { state: "reroute", provider: "openrouter" }
          : bodies.length === 2
            ? { state: "reroute", provider: "groq" }
            : output;
      assert.equal(new Headers(options.headers).get("authorization"), null);
      return new Response(JSON.stringify({ ok: true, data }), {
        status: bodies.length < 3 ? 202 : 200,
      });
    },
  );
  assert.deepEqual(
    await requestNotes(input, "synthetic-csrf", new AbortController().signal),
    output,
  );
  assert.equal(bodies.length, 3);
  assert.equal(new Set(bodies).size, 1);
});
