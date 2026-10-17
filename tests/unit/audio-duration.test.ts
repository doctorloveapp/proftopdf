import { test } from "node:test";
import assert from "node:assert/strict";
import { readMp4Duration } from "../../src/lib/audio/mp4-duration";
import { readAudioDuration } from "../../src/lib/audio/duration";

const bytes = (text: string) => new TextEncoder().encode(text);
function box(type: string, body: Uint8Array[], wide = false, eof = false) {
  const length = body.reduce((sum, value) => sum + value.length, 0);
  const header = new Uint8Array(wide ? 16 : 8);
  const view = new DataView(header.buffer);
  view.setUint32(0, eof ? 0 : wide ? 1 : length + header.length);
  header.set(bytes(type), 4);
  if (wide) view.setBigUint64(8, BigInt(length + header.length));
  const output = new Uint8Array(header.length + length);
  output.set(header);
  let offset = header.length;
  for (const value of body) {
    output.set(value, offset);
    offset += value.length;
  }
  return output;
}
function timeHeader(ticks: bigint, timescale: number, version = 0) {
  const result = new Uint8Array(version ? 40 : 24),
    view = new DataView(result.buffer);
  result[0] = version;
  view.setUint32(version ? 20 : 12, timescale);
  if (version) view.setBigUint64(24, ticks);
  else view.setUint32(16, Number(ticks));
  return result;
}
function track(kind: string, ticks: bigint, timescale: number, version = 0) {
  const handler = new Uint8Array(24);
  handler.set(bytes(kind), 8);
  return box("trak", [
    box("mdia", [
      box("hdlr", [handler]),
      box("mdhd", [timeHeader(ticks, timescale, version)]),
    ]),
  ]);
}
const ftyp = box("ftyp", [bytes("M4A \0\0\0\0isom3gp4")]);
const signal = () => new AbortController().signal;

test("M4A reads v0/v1 audio metadata with empty, generic and Samsung MIME hints, without DOM/Worker or full-file reads", async () => {
  for (const version of [0, 1])
    for (const mime of ["", "application/octet-stream", "audio/x-m4a"]) {
      const file = new File(
        [
          ftyp,
          box("mdat", [new Uint8Array(8_000_000)]),
          box("moov", [track("soun", 7_200_125n, 1000, version)], true),
        ],
        "Voice 001.M4A",
        { type: mime },
      );
      const ranges: [number, number][] = [];
      Object.defineProperty(file, "arrayBuffer", {
        value: () => {
          throw new Error("No whole-file reads");
        },
      });
      Object.defineProperty(file, "slice", {
        value: (start: number, end: number) => {
          ranges.push([start, end]);
          return Blob.prototype.slice.call(file, start, end);
        },
      });
      const events: unknown[] = [];
      assert.equal(
        await readAudioDuration(file, signal(), (event) => events.push(event)),
        7200.125,
      );
      assert(ranges.every(([start, end]) => end - start <= 40));
      assert(ranges.reduce((sum, [start, end]) => sum + end - start, 0) < 512);
      assert(JSON.stringify(events).includes("mp4-js"));
      assert(!JSON.stringify(events).includes("Voice"));
    }
});
test("M4A movie duration preserves presentation edits; MP4 uses sound duration instead of a longer video track", async () => {
  const movie = box("mvhd", [timeHeader(10000n, 1000)]);
  const audio = track("soun", 10023n, 1000);
  assert.equal(
    (await readMp4Duration(
      new Blob([ftyp, box("moov", [audio, movie])]),
      signal(),
    ))!.seconds,
    10,
  );
  const withVideo = new Blob([
    ftyp,
    box("moov", [movie, audio, track("vide", 50000n, 1000)]),
  ]);
  assert.equal((await readMp4Duration(withVideo, signal()))!.seconds, 10.023);
});
test("M4A zero-size final box and unknown movie duration can use valid audio metadata", async () => {
  const file = new Blob([
    ftyp,
    box(
      "moov",
      [
        box("mvhd", [timeHeader(0xffffffffn, 1000)]),
        track("soun", 123456n, 48000),
      ],
      false,
      true,
    ),
  ]);
  assert.equal(
    (await readMp4Duration(file, signal()))!.seconds,
    123456 / 48000,
  );
});
test("Unknown/zero M4A durations, missing audio and unsupported versions are never reported as a valid duration", async () => {
  for (const [ticks, timescale, version] of [
    [0n, 1000, 0],
    [1000n, 0, 0],
    [0xffffffffn, 1000, 0],
    [0xffffffffffffffffn, 1000, 1],
    [1000n, 1000, 2],
  ] as const) {
    assert.equal(
      await readMp4Duration(
        new Blob([
          ftyp,
          box("moov", [track("soun", ticks, timescale, version)]),
        ]),
        signal(),
      ),
      null,
    );
  }
  assert.equal(
    await readMp4Duration(
      new Blob([ftyp, box("moov", [track("vide", 1000n, 1000)])]),
      signal(),
    ),
    null,
  );
});
test("Malformed, truncated, unsafe-sized or excessively numerous MP4 boxes stop within bounded work", async () => {
  const invalid: Uint8Array[] = [];
  for (const size of [1, 4, 100000]) {
    const data = new Uint8Array(8);
    data.set(bytes("mdat"), 4);
    new DataView(data.buffer).setUint32(0, size);
    invalid.push(data);
  }
  const wide = new Uint8Array(16);
  const view = new DataView(wide.buffer);
  view.setUint32(0, 1);
  view.setBigUint64(8, 0xffffffffffffffffn);
  invalid.push(wide);
  invalid.push(box("moov", [box("mvhd", [new Uint8Array(1)])]));
  for (const data of invalid)
    await assert.rejects(
      () => readMp4Duration(new Blob([new Uint8Array(data)]), signal()),
      {
        code: "AUDIO_METADATA_INVALID",
      },
    );
  await assert.rejects(
    () =>
      readMp4Duration(
        new Blob(Array.from({ length: 4097 }, () => box("free", []))),
        signal(),
      ),
    { code: "AUDIO_METADATA_LIMIT" },
  );
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(
    () => readMp4Duration(new Blob([ftyp]), aborted.signal),
    { name: "AbortError" },
  );
});
test("Browser metadata fallback tolerates an initial Infinity and cleans listeners/object URL after finite duration or abort", async (t) => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "document");
  let revoked = 0;
  const audio = {
    duration: Infinity,
    preload: "",
    onloadedmetadata: null as null | (() => void),
    ondurationchange: null as null | (() => void),
    onerror: null as null | (() => void),
    removeAttribute: () => {},
    load: () => {},
    set src(_value: string) {
      queueMicrotask(() => {
        this.onloadedmetadata?.();
        this.duration = 83.5;
        this.ondurationchange?.();
      });
    },
  };
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { createElement: () => audio },
  });
  t.mock.method(URL, "createObjectURL", () => "blob:synthetic");
  t.mock.method(URL, "revokeObjectURL", () => {
    revoked++;
  });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, "document", original);
    else Reflect.deleteProperty(globalThis, "document");
  });
  assert.equal(
    await readAudioDuration(new File(["other format"], "voice.ogg"), signal()),
    83.5,
  );
  assert.equal(audio.onloadedmetadata, null);
  assert.equal(audio.ondurationchange, null);
  assert.equal(audio.onerror, null);
  assert.equal(revoked, 1);
  const aborted = new AbortController();
  Object.defineProperty(audio, "src", {
    set: () => queueMicrotask(() => aborted.abort()),
  });
  await assert.rejects(
    () =>
      readAudioDuration(
        new File(["other format"], "voice.ogg"),
        aborted.signal,
      ),
    { name: "AbortError" },
  );
  assert.equal(revoked, 2);
  assert.equal(audio.onerror, null);
});
