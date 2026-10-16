import assert from "node:assert/strict";
import { mkdtemp, readFile, unlink, rmdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { validateAudioBytes } from "../src/lib/server/audio-validation";
const directory = await mkdtemp(join(tmpdir(), "proftopdf-validate-")),
  files: string[] = [];
try {
  for (const [extension, codec] of [
    ["wav", "pcm_s16le"],
    ["mp3", "libmp3lame"],
    ["m4a", "aac"],
    ["flac", "flac"],
  ]) {
    const path = join(directory, `tone.${extension}`);
    files.push(path);
    const made = spawnSync(
      "ffmpeg",
      [
        "-hide_banner",
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:duration=20:sample_rate=44100",
        "-c:a",
        codec,
        "-y",
        path,
      ],
      { encoding: "utf8", windowsHide: true },
    );
    assert.equal(made.status, 0, made.stderr);
    const bytes = new Uint8Array(await readFile(path));
    if (extension === "flac") {
      await assert.rejects(
        () => validateAudioBytes(bytes, new AbortController().signal),
        { status: 422, code: "AUDIO_NORMALIZATION_REQUIRED" },
      );
      console.log(JSON.stringify({ extension, normalizationRequired: true, untrustedHeaderRejected: true }));
      continue;
    }
    const audio = await validateAudioBytes(bytes, new AbortController().signal);
    assert(audio.duration >= 20 && audio.duration < 21);
    assert(audio.reservedSeconds >= Math.ceil(audio.duration));
    console.log(
      JSON.stringify({
        extension,
        verifiedDuration: audio.duration,
        reservedSeconds: audio.reservedSeconds,
        bytes: bytes.length,
      }),
    );
  }
} finally {
  for (const path of files) await unlink(path).catch(() => {});
  await rmdir(directory);
}
