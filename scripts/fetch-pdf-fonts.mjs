import { mkdir, writeFile, access } from "node:fs/promises";
// OFL-licensed static fonts from the official Noto repository; no paid/CDN runtime.
const base = "https://raw.githubusercontent.com/notofonts/noto-fonts/main";
await mkdir("public/fonts", { recursive: true });
for (const [name, url] of [
  ["NotoSans-Regular.ttf", `${base}/hinted/ttf/NotoSans/NotoSans-Regular.ttf`],
  ["NotoSans-Bold.ttf", `${base}/hinted/ttf/NotoSans/NotoSans-Bold.ttf`],
  ["OFL-NotoSans.txt", `${base}/LICENSE`],
]) {
  const path = `public/fonts/${name}`;
  try {
    await access(path);
    console.log(`${name}: già presente`);
    continue;
  } catch {}
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  await writeFile(path, bytes);
  console.log(`${name}: ${bytes.length} byte`);
}
