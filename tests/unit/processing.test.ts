import { test } from "node:test";
import assert from "node:assert/strict";
import {
  performOperation,
  type OperationDependencies,
} from "../../src/lib/server/operation-core";
import { RouteError, readLimitedBytes } from "../../src/lib/server/http-core";
import { buildTextUnits } from "../../src/lib/notes/assemble";
import {
  buildNotesRequest,
  validateNotesOutput,
} from "../../src/lib/notes/request";
import { mergeTranscripts } from "../../src/lib/transcription/merge";
import { normalizeTranscription } from "../../src/lib/transcription/normalize";
import { validateAudioBytes } from "../../src/lib/server/audio-validation";
import { wavHeader } from "../../src/lib/audio/wav";
import type {
  NotesOutput,
  NotesRequest,
} from "../../src/lib/shared/processing";
import type {
  AudioManifest,
  TranscriptSegment,
} from "../../src/lib/shared/types";
import Groq from "groq-sdk";
import { GROQ_API_ORIGIN } from "../../src/lib/shared/constants";
test("Groq SDK URLs contain exactly one OpenAI API path prefix", async () => {
  const urls: string[] = [];
  const client = new Groq({
    apiKey: "synthetic-test-key",
    baseURL: GROQ_API_ORIGIN,
    maxRetries: 0,
    fetch: async (input) => {
      urls.push(String(input));
      return new Response(JSON.stringify({ text: "synthetic" }), {
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  await client.audio.transcriptions.create({
    model: "whisper-large-v3-turbo",
    file: new File(["test"], "sample.wav"),
  });
  // The SDK may first probe multipart support using a data: URL.
  assert.deepEqual(
    urls.filter((url) => url.startsWith("https:")),
    ["https://api.groq.com/openai/v1/audio/transcriptions"],
  );
});

test("Concurrent inference and a lost response can replay cache but never send the same operation twice", async () => {
  let reserved = false,
    cache: unknown = null,
    calls = 0,
    settled = 0,
    release: () => void = () => {};
  const barrier = new Promise<void>((resolve) => (release = resolve));
  const deps: OperationDependencies = {
    read: async () => cache as never,
    reserve: async () => {
      const acquired = !reserved;
      reserved = true;
      return { acquired, status: "reserved" };
    },
    cache: async (value) => {
      cache = value;
      return true;
    },
    settle: async () => {
      settled++;
    },
    providerError: async () =>
      new RouteError(503, "RESULT_UNCERTAIN", "Ambiguous"),
  };
  const provider = async () => {
    calls++;
    await barrier;
    return { data: "synthetic result", actual: 20 };
  };
  const first = performOperation(deps, provider);
  await new Promise((resolve) => setTimeout(resolve, 0));
  await assert.rejects(
    () => performOperation(deps, provider),
    (e: unknown) => e instanceof RouteError && e.code === "RESULT_UNCERTAIN",
  );
  release();
  assert.equal(await first, "synthetic result");
  assert.equal(await performOperation(deps, provider), "synthetic result");
  cache = null;
  await assert.rejects(() => performOperation(deps, provider), RouteError);
  assert.equal(calls, 1);
  assert.equal(settled, 1);
});
test("Provider timeout keeps reservation and records a replayable failure; quota denial never invokes provider", async () => {
  let cache: unknown = null,
    settles = 0,
    calls = 0;
  const deps: OperationDependencies = {
    read: async () => cache as never,
    reserve: async () => ({ acquired: true, status: "reserved" }),
    cache: async (value) => {
      cache = value;
      return true;
    },
    settle: async () => {
      settles++;
    },
    providerError: async () =>
      new RouteError(503, "RESULT_UNCERTAIN", "Ambiguous"),
  };
  const provider = async () => {
    calls++;
    throw new Error("synthetic timeout");
  };
  await assert.rejects(() => performOperation(deps, provider));
  await assert.rejects(() => performOperation(deps, provider));
  assert.equal(calls, 1);
  assert.equal(settles, 0);
  cache = null;
  deps.reserve = async () => {
    throw new RouteError(429, "QUOTA_EXHAUSTED", "Quota");
  };
  await assert.rejects(() => performOperation(deps, provider));
  assert.equal(calls, 1);
});
test("Transcript batches preserve Unicode and stay below the complete conservative request budget", () => {
  const text =
    "L’energia è conservata: E = mc². La velocità angolare ω e l’angolo α sono grandezze distinte. ".repeat(
      60,
    );
  const segments: TranscriptSegment[] = [
    {
      id: "s0-0",
      chunkId: "x",
      startSeconds: 0,
      endSeconds: 180,
      text,
      status: "confirmed",
    },
  ];
  const units = buildTextUnits(segments);
  assert(units.length > 5);
  assert.equal(
    units
      .flatMap((u) => u.sources.map((s) => s.text))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim(),
    text.trim(),
  );
  for (const unit of units) {
    const input: NotesRequest = {
      jobId: crypto.randomUUID(),
      unitId: unit.id,
      mode: "notes",
      attempt: 0,
      title: "Fisica generale",
      subject: "Fisica",
      sources: unit.sources,
    };
    const request = buildNotesRequest(input);
    assert(
      request.tokenUpperBound <= 6000,
      `Budget ${request.tokenUpperBound}`,
    );
    assert(request.maxOutput > 1000);
  }
});
test("Notes cannot hide uncovered/uncertain sources, invent references, or reorder the outline", () => {
  const input: NotesRequest = {
    jobId: crypto.randomUUID(),
    unitId: "unit-0",
    mode: "notes",
    attempt: 0,
    title: "Test",
    subject: "",
    sources: [{ id: "s0", text: "Principio", uncertain: true }],
  };
  const valid: NotesOutput = {
    sections: [
      {
        title: "Principio",
        paragraphs: ["Un principio."],
        bullets: [],
        concepts: [],
        sourceIds: ["s0"],
      },
    ],
    glossary: [],
    uncertainties: [{ text: "Da verificare", sourceIds: ["s0"] }],
    coveredSourceIds: ["s0"],
  };
  assert.deepEqual(validateNotesOutput(input, valid), valid);
  assert.throws(() =>
    validateNotesOutput(input, {
      ...valid,
      sections: [{ ...valid.sections[0], paragraphs: [] }],
    }),
  );
  const warned = validateNotesOutput(input, {
    ...valid,
    uncertainties: [],
  }) as NotesOutput;
  assert.deepEqual(warned.uncertainties[0].sourceIds, ["s0"]);
  assert.deepEqual(
    (
      validateNotesOutput(input, {
        ...valid,
        coveredSourceIds: ["invented"],
      }) as NotesOutput
    ).coveredSourceIds,
    ["s0"],
  );
  assert.throws(() =>
    validateNotesOutput(input, {
      ...valid,
      sections: [{ ...valid.sections[0], sourceIds: ["invented"] }],
    }),
  );
  const outline = {
    ...input,
    mode: "outline" as const,
    sources: [...input.sources, { id: "s1", text: "Altro", uncertain: false }],
  };
  assert.throws(() =>
    validateNotesOutput(outline, {
      chapters: [{ title: "Titolo", sectionIds: ["s1", "s0"] }],
    }),
  );
});
test("Overlap deduplication is limited to matching text at an overlapping chunk boundary", () => {
  const chunks = [
    { id: "a", index: 0, startSeconds: 0, endSeconds: 20, overlapSeconds: 0 },
    { id: "b", index: 1, startSeconds: 18, endSeconds: 40, overlapSeconds: 2 },
    { id: "c", index: 2, startSeconds: 40, endSeconds: 60, overlapSeconds: 0 },
  ];
  const manifest = { chunks } as AudioManifest;
  const result = (text: string, duration: number) => ({
    sha256: "x",
    model: "mock",
    durationSeconds: duration,
    status: "transcribed" as const,
    segments: [{ start: 0, end: duration, text, uncertain: false }],
  });
  const merged = mergeTranscripts(manifest, {
    a: result("Introduzione: il principio di conservazione", 20),
    b: result("il principio di conservazione descrive l’energia.", 22),
    c: result("descrive l’energia. Una ripetizione voluta.", 20),
  });
  assert.equal(merged[1].text, "descrive l’energia.");
  assert(merged[2].text.startsWith("descrive l’energia."));
});
test("Provider metadata marks uncertain speech and invalid duration cannot be silently accepted", () => {
  const raw = {
    text: "Concetto",
    duration: 10,
    segments: [
      {
        start: 0,
        end: 10,
        text: "Concetto",
        avg_logprob: -2,
        no_speech_prob: 0.9,
      },
    ],
  };
  assert.equal(
    normalizeTranscription(raw, 10, "sha", "mock").segments[0].uncertain,
    true,
  );
  assert.throws(
    () => normalizeTranscription(raw, 30, "sha", "mock"),
    RouteError,
  );
});
test("Server verifies actual audio bytes and caps streamed bodies without trusting Content-Length", async () => {
  const format = {
    channels: 1,
    sampleRate: 16000,
    bits: 16,
    blockAlign: 2,
    byteRate: 32000,
  };
  const blob = new Blob([wavHeader(format, 320000), new Uint8Array(320000)]);
  const valid = await validateAudioBytes(
    new Uint8Array(await blob.arrayBuffer()),
    new AbortController().signal,
  );
  assert.equal(valid.duration, 10);
  assert(valid.reservedSeconds >= 10);
  await assert.rejects(
    () =>
      validateAudioBytes(
        new Uint8Array([1, 2, 3]),
        new AbortController().signal,
      ),
    RouteError,
  );
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(60));
      controller.enqueue(new Uint8Array(60));
      controller.close();
    },
  });
  const request = new Request("https://example.com", {
    method: "POST",
    body: stream,
    duplex: "half",
    headers: { "content-length": "1" },
  } as RequestInit);
  await assert.rejects(
    () => readLimitedBytes(request, 100),
    (e: unknown) => e instanceof RouteError && e.status === 413,
  );
});
