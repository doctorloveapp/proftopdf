import { cp, mkdir, copyFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const output = resolve("public/ffmpeg/v0.12.15-core0.12.10");
await mkdir(resolve(output, "core"), { recursive: true });
await cp(resolve("node_modules/@ffmpeg/ffmpeg/dist/esm"), output, {
  recursive: true,
  filter: (path) => !path.endsWith(".d.ts"),
});
for (const name of ["ffmpeg-core.js", "ffmpeg-core.wasm"])
  await copyFile(
    resolve("node_modules/@ffmpeg/core/dist/esm", name),
    resolve(output, "core", name),
  );
await writeFile(
  resolve(output, "NOTICE.txt"),
  "FFmpeg.wasm wrapper: @ffmpeg/ffmpeg 0.12.15 (MIT). Core: @ffmpeg/core 0.12.10 (FFmpeg and bundled libraries; GPL terms apply to the distributed core). Source and licenses: https://github.com/ffmpegwasm/ffmpeg.wasm/tree/v0.12.15 and https://github.com/ffmpegwasm/ffmpeg.wasm/tree/main/packages/core\n",
);
console.log(
  "Worker e core single-thread FFmpeg copiati localmente (nessun CDN esterno).",
);
