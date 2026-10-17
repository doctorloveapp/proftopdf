import type { LectureDocument } from "@/lib/shared/types";
import type { PdfDiagnostic } from "./diagnostics";
export function createPdf(
  document: LectureDocument,
  markdown: string | undefined,
  signal: AbortSignal,
  onDiagnostic?: PdfDiagnostic,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const worker = new Worker("/pdf/pdf.worker.js", { type: "module" });
    let timer: ReturnType<typeof setTimeout>;
    const close = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      worker.terminate();
    };
    const abort = () => {
      close();
      reject(new DOMException("Generazione PDF interrotta.", "AbortError"));
    };
    worker.onerror = () => {
      close();
      reject(
        new Error(
          "Il worker PDF non si è avviato. Ricarica la pagina dopo il deploy e riprova. [PDF_WORKER_LOAD]",
          { cause: { code: "PDF_WORKER_LOAD" } },
        ),
      );
    };
    worker.onmessage = ({ data }) => {
      if (data.type === "font-diagnostic") {
        onDiagnostic?.(data.event, data.details);
        return;
      }
      close();
      if (data.ok && data.buffer instanceof ArrayBuffer)
        resolve(new Blob([data.buffer], { type: "application/pdf" }));
      else
        reject(
          new Error(
            `${data.message ?? "PDF non disponibile."} [${data.code ?? "PDF_RENDER_FAILED"}]`,
            {
              cause: {
                code: data.code,
                nativeName: data.nativeName,
                technicalMessage: data.technicalMessage,
              },
            },
          ),
        );
    };
    signal.addEventListener("abort", abort, { once: true });
    timer = setTimeout(() => {
      close();
      reject(
        new Error(
          "Il PDF non è stato generato entro 120 secondi. [PDF_TIMEOUT]",
          { cause: { code: "PDF_TIMEOUT" } },
        ),
      );
    }, 120_000);
    if (signal.aborted) abort();
    else worker.postMessage({ document, markdown });
  });
}
