import { build } from "esbuild";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
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
