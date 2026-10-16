export type AudioDetails = Record<string, string | number | boolean | null>;

export class AudioProcessingError extends Error {
  constructor(
    public readonly code: string,
    public readonly phase: string,
    message: string,
    public readonly details: AudioDetails = {},
  ) {
    super(`${message} [${code}]`);
    this.name = "AudioProcessingError";
  }
}

export function audioFailure(error: unknown, phase: string) {
  if (error instanceof AudioProcessingError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const name = error instanceof Error ? error.name : "WorkerError";
  const native = {
    nativeName: name,
    nativeMessage: message
      .replace(/https?:\/\/\S+/g, "[url]")
      .replace(/(password|token|secret|cookie)\s*[:=]\s*\S+/gi, "$1=[redacted]")
      .slice(0, 600),
  };
  if (
    /out of memory|memory access out of bounds|allocation|cannot enlarge|Array buffer allocation/i.test(
      message,
    )
  )
    return new AudioProcessingError(
      "AUDIO_MEMORY",
      phase,
      "Memoria del browser insufficiente o errore di memoria del motore audio. Chiudi altre schede e riprova.",
      native,
    );
  if (
    /fetch|network|import|loading|WebAssembly|compile|linkerror/i.test(message)
  )
    return new AudioProcessingError(
      "AUDIO_ENGINE_LOAD",
      phase,
      "Download o inizializzazione del motore WASM fallito. Verifica la connessione e riprova.",
      native,
    );
  if (name === "QuotaExceededError")
    return new AudioProcessingError(
      "AUDIO_STORAGE_FULL",
      phase,
      "Spazio esaurito: libera spazio e riprendi la preparazione.",
    );
  return new AudioProcessingError(
    "AUDIO_PREPARATION",
    phase,
    error instanceof Error
      ? error.message
      : "Il motore audio ha interrotto l’operazione. Esporta il log diagnostico.",
    native,
  );
}

// An outer watchdog also handles a worker that stops replying. The engine's
// own timeout alone cannot reject that pending message. All listeners are freed.
export async function audioOperation<T>(
  operation: () => Promise<T>,
  phase: string,
  timeoutMs: number,
  signal: AbortSignal,
  terminate: () => void,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let aborted: () => void = () => {};
  try {
    if (signal.aborted)
      throw new DOMException("Preparazione interrotta.", "AbortError");
    return await Promise.race([
      Promise.resolve().then(() => {
        if (signal.aborted)
          throw new DOMException("Preparazione interrotta.", "AbortError");
        return operation();
      }),
      new Promise<never>((_, reject) => {
        aborted = () => {
          reject(new DOMException("Preparazione interrotta.", "AbortError"));
          terminate();
        };
        signal.addEventListener("abort", aborted, { once: true });
        timer = setTimeout(() => {
          reject(
            new AudioProcessingError(
              "AUDIO_WORKER_TIMEOUT",
              phase,
              `Il motore audio non ha risposto entro ${Math.round(timeoutMs / 1000)} secondi. Esporta il log e riprova.`,
              { timeoutMs },
            ),
          );
          terminate();
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", aborted);
  }
}
