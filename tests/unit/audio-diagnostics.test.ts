import assert from "node:assert/strict";
import { test } from "node:test";
import {
  audioFailure,
  audioOperation,
  AudioProcessingError,
} from "../../src/lib/audio/errors";
import { parseAudioProbe } from "../../src/lib/audio/probe";
import {
  createAudioLog,
  exportAudioLog,
  removeAudioLog,
} from "../../src/lib/audio/diagnostics";

test("Core ffprobe sentinel is accepted only with fresh valid JSON and no stderr errors", () => {
  const valid = JSON.stringify({
    streams: [{ codec_name: "mp3", duration: "10" }],
    format: { bit_rate: "128000" },
  });
  assert.equal(parseAudioProbe(-1, valid, []).duration, 10);
  assert.equal(parseAudioProbe(0, valid, []).bitrate, 128000);
  assert.equal(
    parseAudioProbe(
      -1,
      JSON.stringify({
        streams: [{ codec_name: "aac", duration: "N/A" }],
        format: { duration: "2", bit_rate: "-1" },
      }),
      [],
    ).duration,
    2,
  );
  for (const [code, raw, stderr] of [
    [-1, "{}", []],
    [-1, valid, ["Invalid argument"]],
    [1, valid, []],
    [-1, "invalid", []],
  ] as [number, string, string[]][])
    assert.throws(
      () => parseAudioProbe(code, raw, stderr),
      AudioProcessingError,
    );
});

test("Worker watchdog, explicit cancellation, and memory/network classification preserve precise causes", async () => {
  let terminated = 0;
  await assert.rejects(
    () =>
      audioOperation(
        () => new Promise(() => {}),
        "load",
        10,
        new AbortController().signal,
        () => terminated++,
      ),
    (e: unknown) =>
      e instanceof AudioProcessingError &&
      e.code === "AUDIO_WORKER_TIMEOUT" &&
      e.phase === "load",
  );
  assert.equal(terminated, 1);
  const controller = new AbortController();
  const pending = audioOperation(
    () => new Promise(() => {}),
    "segment",
    1000,
    controller.signal,
    () => terminated++,
  );
  controller.abort();
  await assert.rejects(() => pending, { name: "AbortError" });
  assert.equal(terminated, 2);
  assert.equal(
    audioFailure(new Error("memory access out of bounds"), "segment").code,
    "AUDIO_MEMORY",
  );
  assert.equal(
    audioFailure(new TypeError("Failed to fetch"), "load").code,
    "AUDIO_ENGINE_LOAD",
  );
});

test("Downloadable diagnostics survive reload, cap history and work when local storage is full", (t) => {
  t.mock.method(console, "info", () => {});
  t.mock.method(console, "error", () => {});
  const values = new Map<string, string>();
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    },
  });
  try {
    const id = crypto.randomUUID();
    const log = createAudioLog(id);
    log("fingerprint.start", { bytes: 8600000 });
    createAudioLog(id)(
      "preparation.failed",
      { code: "MP3_FRAME_INVALID", byteOffset: 1234 },
      "error",
    );
    const report = JSON.parse(exportAudioLog(id));
    assert.equal(report.events.length, 2);
    assert.equal(report.events[1].details.byteOffset, 1234);
    assert.equal(report.persistent, true);
    const again = createAudioLog(id);
    for (let i = 0; i < 220; i++) again("progress", { index: i });
    const bounded = JSON.parse(exportAudioLog(id));
    assert.equal(bounded.events.length, 200);
    assert.equal(bounded.droppedEvents, 22);
    assert.equal(bounded.events.at(-1).details.index, 219);
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem() {
          throw new DOMException("Full", "QuotaExceededError");
        },
      },
    });
    again("last.error", { code: "AUDIO_STORAGE_FULL" }, "error");
    assert.equal(
      JSON.parse(exportAudioLog(id)).events.at(-1).event,
      "last.error",
    );
    assert.equal(JSON.parse(exportAudioLog(id)).persistent, false);
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
      },
    });
    removeAudioLog(id);
    assert.throws(() => exportAudioLog(id), /Nessun log/);
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem() {
          throw new DOMException("Full", "QuotaExceededError");
        },
      },
    });
    const fallback = crypto.randomUUID();
    createAudioLog(fallback)("storage.unavailable");
    assert.equal(JSON.parse(exportAudioLog(fallback)).persistent, false);
    removeAudioLog(fallback);
  } finally {
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});
