/// <reference lib="webworker" />
import { renderLecturePdf } from "../lib/pdf/render";
import type { LectureDocument } from "../lib/shared/types";
import type { PdfDiagnostic } from "../lib/pdf/diagnostics";
const worker = self as unknown as DedicatedWorkerGlobalScope;
worker.onmessage = async ({
  data,
}: {
  data: { document: LectureDocument; markdown?: string };
}) => {
  try {
    const fetchFont = async (name: string) => {
      const response = await fetch(
        new URL(`/fonts/${name}`, worker.location.origin),
      );
      if (!response.ok)
        throw new Error(`PDF_FONT_HTTP ${name} ${response.status}`);
      return new Uint8Array(await response.arrayBuffer());
    };
    const fonts = await Promise.all(
      ["NotoSans-Regular.ttf", "NotoSans-Bold.ttf"].map(async (name) => {
        return fetchFont(name);
      }),
    );
    const bytes = await renderLecturePdf(data.document, data.markdown, {
      regular: fonts[0],
      bold: fonts[1],
      loadMath: () => fetchFont("NotoSansMath-Regular.ttf"),
      onDiagnostic: ((event, details) =>
        worker.postMessage({
          type: "font-diagnostic",
          event,
          details,
        })) satisfies PdfDiagnostic,
    });
    const buffer = new Uint8Array(bytes).buffer;
    worker.postMessage({ ok: true, buffer }, [buffer]);
  } catch (error) {
    const native =
      error instanceof Error ? error.message : "Unknown worker error";
    let code = "PDF_RENDER_FAILED",
      message =
        "Generazione PDF non riuscita. Esporta il log diagnostico; puoi comunque scaricare gli appunti Markdown.";
    if (native.startsWith("PDF_UNSUPPORTED_GLYPH")) {
      code = "PDF_UNSUPPORTED_GLYPH";
      message = `I font PDF disponibili non contengono un simbolo (${native.split(" ").at(-1)}). Gli appunti sono salvati: esporta il log oppure modifica il simbolo e riprova solo "Prepara PDF", senza rifare la trascrizione.`;
    } else if (/PDF_FONT_HTTP|fetch|network/i.test(native)) {
      code = "PDF_FONT_LOAD";
      message =
        "Download dei font PDF fallito. Verifica la connessione e riprova.";
    } else if (/memory|allocation/i.test(native)) {
      code = "PDF_MEMORY";
      message =
        "Memoria insufficiente per il PDF. Chiudi altre schede e riprova.";
    }
    worker.postMessage({
      ok: false,
      code,
      nativeName: error instanceof Error ? error.name : "UnknownError",
      technicalMessage: native
        .replace(/(?:https?|file):\/\/\S+/g, "[worker]")
        .slice(0, 500),
      message,
    });
  }
};
