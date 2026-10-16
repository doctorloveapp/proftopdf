import { readFile, readdir } from 'node:fs/promises';
import { resolve, relative, join } from 'node:path';

const root = resolve('.');
const failures = [];
const ignores = await readFile(join(root, '.gitignore'), 'utf8');
const rules = ignores.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));
for (const required of ['.env', '.env.*', '**/.env', '**/.env.*', 'Documenti/', '**/Documenti/', 'node_modules/', '.next/', 'dist/', '.vercel/', '*.log', 'tmp/']) {
  if (!rules.includes(required)) failures.push(`Regola di esclusione mancante: ${required}`);
}
if (rules.some((rule) => rule.startsWith('!'))) failures.push('Rilevata una eccezione alle esclusioni: verificare i file privati.');

function isPrivatePath(path) {
  return /(^|\/)\.env(?:\.|$)/.test(path) || /(^|\/)Documenti(?:\/|$)/i.test(path);
}

// Read the index as a file; never invoke Git. Ignore rules cannot untrack an
// already committed secret, so report that condition without changing history.
let trackedEntries = 0;
try {
  const index = await readFile(join(root, '.git', 'index'));
  const version = index.readUInt32BE(4);
  if (index.toString('ascii', 0, 4) !== 'DIRC' || ![2, 3].includes(version)) {
    failures.push('Formato indice non supportato: il proprietario deve verificare i file tracciati con Git.');
  } else {
    const count = index.readUInt32BE(8);
    let position = 12;
    for (let n = 0; n < count; n += 1) {
      const start = position;
      if (position + 62 > index.length) throw new Error('Invalid index');
      const flags = index.readUInt16BE(position + 60);
      position += 62;
      if (version >= 3 && (flags & 0x4000)) position += 2;
      const end = index.indexOf(0, position);
      if (end < 0) throw new Error('Invalid index');
      const path = index.toString('utf8', position, end);
      trackedEntries += 1;
      if (isPrivatePath(path)) failures.push(`File privato già tracciato: ${path}. Deve intervenire il proprietario.`);
      position = start + Math.ceil((end + 1 - start) / 8) * 8;
    }
  }
} catch (error) {
  if (error.code !== 'ENOENT') failures.push('Indice non verificabile senza intervento del proprietario.');
}

try { process.loadEnvFile(join(root, '.env')); } catch (error) { if (error.code !== 'ENOENT') throw new Error('Configurazione locale illeggibile.'); }
const secretNames = ['GROQ_API_KEY', 'UPSTASH_REDIS_REST_TOKEN', 'SESSION_SECRET', 'APP_ACCESS_PASSWORD'];
const secrets = secretNames.map((key) => process.env[key]).filter((value) => value && value.length >= 8);
const excluded = new Set(['.git', '.next', '.cache', '.vercel', 'node_modules', 'Documenti', 'assets', 'tmp', 'temp']);
const textExtensions = /\.(?:tsx?|m?js|cjs|json|md|css|txt|example)$/i;
let scannedFiles = 0;

async function scan(directory, clientOnly = false) {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) { if (clientOnly || !excluded.has(entry.name)) await scan(path, clientOnly); continue; }
    if (entry.name.startsWith('.env') || !textExtensions.test(entry.name)) continue;
    const contents = await readFile(path, 'utf8');
    scannedFiles += 1;
    if (secrets.some((secret) => contents.includes(secret))) failures.push(`Possibile credenziale in ${relative(root, path)} (valore nascosto).`);
  }
}
await scan(root);
await scan(join(root, '.next', 'static'), true);

if (failures.length) {
  failures.forEach((failure) => console.error(failure));
  process.exitCode = 1;
} else {
  console.log(`Esclusioni corrette; ${trackedEntries} voci indice controllate senza comandi Git; ${scannedFiles} file di testo verificati. Nessuna credenziale nota rilevata.`);
}
