// Optional independent decoder check: requires local ffmpeg and ffprobe binaries.
// Generates tones, never reads the user's audio, never starts a server.
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, unlink, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { openMp3 } from "../src/lib/audio/mp3";
import { nextChunkStart } from "../src/lib/audio/wav";
import { AUDIO_LIMITS } from "../src/lib/shared/constants";
const directory = await mkdtemp(join(tmpdir(), "proftopdf-mp3-"));
const files: string[] = [];
function run(binary: string, args: string[]) {
  const result = spawnSync(binary, args, {
    encoding: "utf8",
    windowsHide: true,
    timeout: 120_000,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${binary}: ${result.stderr.slice(-2000)}`);
  return result;
}
try {
  for (const variant of [
    { name: "cbr", rate: 44100, args: ["-b:a", "224k"] },
    { name: "vbr", rate: 44100, args: ["-q:a", "2"] },
    { name: "mpeg2", rate: 16000, args: ["-b:a", "48k"] },
  ]) {
    const source = join(directory, `${variant.name}.mp3`);
    files.push(source);
    run("ffmpeg", [
      "-hide_banner",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      `sine=frequency=440:sample_rate=${variant.rate}:duration=310`,
      "-c:a",
      "libmp3lame",
      ...variant.args,
      "-y",
      source,
    ]);
    const data = await readFile(source);
    const started = performance.now();
    const audio = await openMp3(new Blob([data]), new AbortController().signal);
    const scanMs = Math.round(performance.now() - started);
    let start = 0,
      count = 0;
    while (true) {
      const part = audio.chunk(start);
      assert(part.blob.size <= AUDIO_LIMITS.maxChunkBytes);
      const path = join(directory, `${variant.name}-${count}.mp3`);
      files.push(path);
      await writeFile(path, new Uint8Array(await part.blob.arrayBuffer()));
      const probe = JSON.parse(
        run("ffprobe", [
          "-v",
          "error",
          "-show_entries",
          "format=duration",
          "-of",
          "json",
          path,
        ]).stdout,
      );
      assert(
        Math.abs(
          Number(probe.format.duration) - (part.endSeconds - part.startSeconds),
        ) < 0.001,
      );
      const decoded = run("ffmpeg", [
        "-hide_banner",
        "-v",
        "error",
        "-i",
        path,
        "-f",
        "null",
        "-",
      ]);
      assert.equal(
        decoded.stderr.trim(),
        "",
        `Decoder errors: ${decoded.stderr}`,
      );
      count++;
      const next = nextChunkStart(
        part.startSeconds,
        part.endSeconds,
        audio.duration,
      );
      if (next === null) break;
      start = next;
    }
    console.log(
      JSON.stringify({
        variant: variant.name,
        bytes: data.length,
        durationSeconds: audio.duration,
        scanMs,
        chunks: count,
        independentDecode: "passed",
      }),
    );
  }
} finally {
  // Delete only explicitly created files; no recursive deletion.
  for (const path of files) await unlink(path).catch(() => {});
  await rmdir(directory);
}
