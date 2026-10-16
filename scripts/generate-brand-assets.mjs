import sharp from 'sharp';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const source = resolve('assets/logo.jpg');
const output = resolve('public');
await mkdir(output, { recursive: true });
const metadata = await sharp(source).metadata();
if (metadata.width !== 764 || metadata.height !== 606) {
  throw new Error('Il file logo sorgente è cambiato: ricontrollare i ritagli prima di generare le icone.');
}

// Deterministic derivatives of the provided logo. Keep the source intact.
// The professor mark remains legible at favicon sizes; the full wordmark is
// retained for the navigation. No generated or redrawn brand elements.
const professor = { left: 202, top: 102, width: 168, height: 252 };
const wordmark = { left: 107, top: 375, width: 579, height: 103 };
// Exclude the beginnings of the adjacent arrows from the isolated symbol,
// while retaining the cap, tassel, face and complete book.
const symbolMask = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="168" height="252"><path fill="white" d="M0 0H168V48H150V75H136V126H168V252H0Z"/></svg>');
const symbol = await sharp(source).extract(professor).ensureAlpha()
  .composite([{ input: symbolMask, blend: 'dest-in' }]).png().toBuffer();
const pngBySize = new Map();
for (const [name, size, paddingRatio] of [
  ['favicon-16x16.png', 16, .06],
  ['favicon-32x32.png', 32, .06],
  ['apple-touch-icon.png', 180, .12],
  ['icon-192x192.png', 192, .12],
  ['icon-512x512.png', 512, .12],
  ['icon-maskable-512x512.png', 512, .22],
]) {
  const inset = Math.round(size * paddingRatio);
  const inner = size - inset * 2;
  const icon = await sharp(symbol).flatten({ background: '#f5f9fc' })
    .resize(inner, inner, { fit: 'contain', background: '#f5f9fc' })
    .extend({ top: inset, bottom: inset, left: inset, right: inset, background: '#f5f9fc' })
    .png().toBuffer();
  await writeFile(resolve(output, name), icon);
  if (size === 16 || size === 32) pngBySize.set(size, icon);
}

// ICO directory entries with embedded PNG images, supported by modern browsers.
const sizes = [16, 32];
const header = Buffer.alloc(6 + 16 * sizes.length);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(sizes.length, 4);
let offset = header.length;
sizes.forEach((size, index) => {
  const entry = 6 + index * 16;
  const bytes = pngBySize.get(size);
  header[entry] = size;
  header[entry + 1] = size;
  header.writeUInt16LE(1, entry + 4);
  header.writeUInt16LE(32, entry + 6);
  header.writeUInt32LE(bytes.length, entry + 8);
  header.writeUInt32LE(offset, entry + 12);
  offset += bytes.length;
});
await writeFile(resolve(output, 'favicon.ico'), Buffer.concat([header, ...sizes.map((size) => pngBySize.get(size))]));
await sharp(source).extract(wordmark).resize({ width: 579 }).webp({ quality: 90 }).toFile(resolve(output, 'logo-navbar.webp'));
await sharp(source).resize({ width: 764 }).webp({ quality: 86 }).toFile(resolve(output, 'logo.webp'));
await sharp(source).resize({ width: 764 }).png({ compressionLevel: 9 }).toFile(resolve(output, 'logo.png'));
console.log('Asset generati dal logo originale: favicon, icone iOS/Android, icona maskable e loghi ottimizzati.');
