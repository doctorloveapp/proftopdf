// Local FFmpeg-generated tones only. No user recordings, browser/server or API.
import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  unlink,
  rmdir,
  mkdir,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { readAudioDuration } from "../src/lib/audio/duration";
import { readMp4Duration } from "../src/lib/audio/mp4-duration";

const directory = await mkdtemp(join(tmpdir(), "proftopdf-metadata-"));
const paths: string[] = [];
const results: unknown[] = [];
try {
  for (const [name, rate, channels, fastStart, brand] of [
    ["aac-tail", 44100, 1, false, "M4A "],
    ["aac-faststart", 48000, 2, true, "M4A "],
    ["3gp4-brand", 48000, 1, false, "3gp4"],
  ] as const) {
    const path = join(directory, `${name}.m4a`);
    paths.push(path);
    const made = spawnSync(
      "ffmpeg",
      [
        "-hide_banner",
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        `sine=frequency=440:duration=13.37:sample_rate=${rate}`,
        "-ac",
        String(channels),
        "-c:a",
        "aac",
        "-brand",
        brand,
        ...(fastStart ? ["-movflags", "+faststart"] : []),
        "-y",
        path,
      ],
      { encoding: "utf8", windowsHide: true },
    );
    assert.equal(made.status, 0, made.stderr);
    const probed = spawnSync(
      "ffprobe",
      ["-v", "error", "-show_entries", "format=duration", "-of", "json", path],
      { encoding: "utf8", windowsHide: true },
    );
    assert.equal(probed.status, 0, probed.stderr);
    const expected = Number(JSON.parse(probed.stdout).format.duration);
    const file = new File([await readFile(path)], "Voice 001.m4a", {
      type: "application/octet-stream",
    });
    const metadata = await readMp4Duration(file, new AbortController().signal);
    assert(metadata);
    assert(Math.abs(metadata.seconds - expected) < 0.05);
    assert.equal(
      await readAudioDuration(file, new AbortController().signal),
      metadata.seconds,
    );
    assert(metadata.bytesRead < 4096);
    results.push({
      name,
      format: "generated AAC/M4A",
      sampleRate: rate,
      channels,
      fastStart,
      brand,
      bytes: file.size,
      ffprobeSeconds: expected,
      detectedSeconds: metadata.seconds,
      metadataBytesRead: metadata.bytesRead,
      boxesRead: metadata.boxesRead,
    });
  }
  const report = {
    checkedAt: new Date().toISOString(),
    ok: true,
    evidence:
      "synthetic tones in real AAC/M4A containers; not Samsung/iOS recordings or a deployed browser test",
    results,
  };
  await mkdir("docs", { recursive: true });
  await writeFile(
    "docs/audio-metadata-v11.json",
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  for (const path of paths) await unlink(path).catch(() => {});
  await rmdir(directory);
}
