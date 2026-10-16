// Synthetic core regression, without a browser/server, network or real recordings.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { wavHeader } from "../src/lib/audio/wav";
import { parseAudioProbe } from "../src/lib/audio/probe";
const require = createRequire(import.meta.url);
Object.assign(globalThis, {
  self: { location: { href: "file:///ffmpeg-core.js" } },
});
const core = await require("@ffmpeg/core")({
  wasmBinary: readFileSync(
    "node_modules/@ffmpeg/core/dist/umd/ffmpeg-core.wasm",
  ),
});
const format = {
  channels: 1,
  sampleRate: 16000,
  bits: 16,
  blockAlign: 2,
  byteRate: 32000,
};
const blob = new Blob([wavHeader(format, 32000), new Uint8Array(32000)]);
core.FS.writeFile("/source", new Uint8Array(await blob.arrayBuffer()));
let stderr: string[] = [];
core.setLogger(({ type, message }: { type: string; message: string }) => {
  if (type === "stderr" && message.trim() && message.trim() !== "Aborted()")
    stderr.push(message);
});
function probe(path = "/source") {
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
  return {
    code: core.ret as number,
    raw: core.FS.readFile("/probe.json", { encoding: "utf8" }) as string,
  };
}
const valid = probe();
assert.equal(parseAudioProbe(valid.code, valid.raw, stderr).duration, 1);
console.log(
  JSON.stringify({
    check: "valid synthetic WAV",
    coreExit: valid.code,
    validated: true,
  }),
);
core.reset();
core.FS.unlink("/probe.json");
stderr = [];
core.exec(
  "-hide_banner",
  "-v",
  "error",
  "-i",
  "/source",
  "-c:a",
  "aac",
  "-y",
  "/encoded.m4a",
);
assert.equal(core.ret, 0, stderr.join("\n"));
assert.equal(stderr.length, 0, stderr.join("\n"));
core.reset();
const m4a = probe("/encoded.m4a");
assert.equal(parseAudioProbe(m4a.code, m4a.raw, stderr).codec, "aac");
console.log(
  JSON.stringify({
    check: "synthetic M4A/AAC",
    coreExit: m4a.code,
    validated: true,
  }),
);
core.reset();
core.FS.unlink("/probe.json");
core.FS.writeFile("/source", new Uint8Array(100));
stderr = [];
const invalid = probe();
assert.throws(() => parseAudioProbe(invalid.code, invalid.raw, stderr));
console.log(
  JSON.stringify({
    check: "invalid synthetic audio",
    coreExit: invalid.code,
    correctlyRejected: true,
  }),
);
