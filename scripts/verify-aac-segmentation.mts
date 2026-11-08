// Synthetic integration: native encoder, real @ffmpeg/core WASM decoder, exact
// production segment arguments/policy and server byte validator. No APIs,
// credentials, browser, localhost server, or user recordings.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, unlink, rmdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  segmentArguments,
  segmentEnd,
  segmentPlan,
} from "../src/lib/audio/segment-policy";
import { parseAudioProbe } from "../src/lib/audio/probe";
import { nextChunkStart } from "../src/lib/audio/wav";
import { validateAudioBytes } from "../src/lib/server/audio-validation";

const require = createRequire(import.meta.url);
Object.assign(globalThis, {
  self: { location: { href: "file:///ffmpeg-core.js" } },
});
const core = await require("@ffmpeg/core")({
  wasmBinary: readFileSync(
    "node_modules/@ffmpeg/core/dist/umd/ffmpeg-core.wasm",
  ),
});
core.FS.mkdir("/input");
let stderr: string[] = [];
core.setLogger(({ type, message }: { type: string; message: string }) => {
  if (type === "stderr" && message.trim() && message.trim() !== "Aborted()")
    stderr.push(message);
});
function probe(path: string) {
  stderr = [];
  core.ffprobe(
    "-v",
    "error",
    "-select_streams",
    "a:0",
    "-show_entries",
    "format=duration,bit_rate:stream=codec_name,duration",
    "-of",
    "json",
    path,
    "-o",
    "/probe.json",
  );
  const data = parseAudioProbe(
    core.ret,
    core.FS.readFile("/probe.json", { encoding: "utf8" }),
    stderr,
  );
  core.FS.unlink("/probe.json");
  core.reset();
  return data;
}
const directory = await mkdtemp(join(tmpdir(), "proftopdf-wasm-aac-"));
const path = join(directory, "synthetic.m4a");
try {
  for (const [seconds, rate] of [
    [818.581333, 48000],
    [90.037333, 44100],
    [0.15, 48000],
  ]) {
    const made = spawnSync(
      "ffmpeg",
      [
        "-hide_banner",
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        `sine=frequency=440:sample_rate=${rate}`,
        "-t",
        String(seconds),
        "-c:a",
        "aac",
        "-b:a",
        "64000",
        "-y",
        path,
      ],
      { encoding: "utf8", windowsHide: true },
    );
    assert.equal(made.status, 0, made.stderr);
    core.FS.writeFile("/input/source", new Uint8Array(await readFile(path)));
    const source = probe("/input/source");
    const chunks: {
      start: number;
      end: number;
      measured: number;
      bytes: number;
    }[] = [];
    let start = 0;
    while (true) {
      const plan = segmentPlan(start, source.duration, false, source.bitrate);
      stderr = [];
      core.exec(
        ...segmentArguments(start, plan.span, false, "wav"),
        "-y",
        "/chunk.wav",
      );
      assert.equal(core.ret, 0, stderr.join("\n"));
      assert.equal(stderr.length, 0, stderr.join("\n"));
      core.reset();
      const measured = probe("/chunk.wav").duration;
      const bytes = new Uint8Array(core.FS.readFile("/chunk.wav"));
      assert(bytes.byteLength <= 3_200_000);
      const validated = await validateAudioBytes(
        bytes,
        new AbortController().signal,
      );
      assert(Math.abs(validated.duration - measured) < 0.00001);
      const end = segmentEnd(
        start,
        source.duration,
        plan.span,
        measured,
        plan.final,
      );
      chunks.push({ start, end, measured, bytes: bytes.byteLength });
      core.FS.unlink("/chunk.wav");
      const next = nextChunkStart(start, end, source.duration);
      if (next === null) break;
      assert(next > start);
      assert(chunks.length < 20, "Unbounded tail fragmentation");
      start = next;
    }
    assert.equal(chunks.at(-1)!.end, source.duration);
    assert.equal(chunks.length, seconds > 100 ? 10 : seconds > 90 ? 2 : 1);
    console.log(
      JSON.stringify({
        evidence:
          "synthetic AAC / actual WASM core / production policy / server validation",
        rate,
        sourceSeconds: source.duration,
        chunks,
      }),
    );
    core.FS.unlink("/input/source");
  }
} finally {
  await unlink(path).catch(() => {});
  await rmdir(directory);
}
