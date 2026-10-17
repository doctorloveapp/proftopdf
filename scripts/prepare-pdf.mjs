import { build } from "esbuild";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
// Fonts are source assets committed by the owner, not build-time downloads.
for (const name of [
  "NotoSans-Regular.ttf",
  "NotoSans-Bold.ttf",
  "NotoSansMath-Regular.ttf",
]) {
  const bytes = await readFile(resolve("public/fonts", name));
  if (
    bytes.length < 4 ||
    ![0x00010000, 0x4f54544f].includes(bytes.readUInt32BE(0))
  )
    throw new Error(`Asset font PDF non valido: ${name}`);
}
await readFile(resolve("public/fonts/OFL-NotoSansMath.txt"));
await mkdir("public/pdf", { recursive: true });
await build({
  absWorkingDir: process.cwd(),
  tsconfigRaw: JSON.parse(await readFile("tsconfig.json", "utf8")),
  entryPoints: [resolve("src/workers/pdf.worker.ts")],
  outfile: resolve("public/pdf/pdf.worker.js"),
  bundle: true,
  platform: "browser",
  format: "esm",
  target: "es2022",
  minify: false,
  legalComments: "linked",
  define: { "process.env.NODE_ENV": '"production"' },
});
console.log(
  "Worker PDF generato localmente (font locali, nessun servizio esterno).",
);
