import { sha256 } from "@noble/hashes/sha2.js";

export function abortIfNeeded(signal: AbortSignal) {
  if (signal.aborted)
    throw new DOMException("Preparazione interrotta.", "AbortError");
}
export async function fingerprint(
  blob: Blob,
  signal: AbortSignal,
  progress?: (fraction: number) => void,
) {
  const hash = sha256.create();
  for (let offset = 0; offset < blob.size; offset += 1_048_576) {
    abortIfNeeded(signal);
    hash.update(
      new Uint8Array(
        await blob.slice(offset, offset + 1_048_576).arrayBuffer(),
      ),
    );
    progress?.(Math.min(1, (offset + 1_048_576) / blob.size));
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  abortIfNeeded(signal);
  return Array.from(hash.digest(), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
