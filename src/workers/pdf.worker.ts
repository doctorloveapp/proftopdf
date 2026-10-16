/// <reference lib="webworker" />
import { renderLecturePdf } from "../lib/pdf/render";
import type { LectureDocument } from "../lib/shared/types";
const worker = self as unknown as DedicatedWorkerGlobalScope;
worker.onmessage = async ({
  data,
}: {
  data: { document: LectureDocument; markdown?: string };
}) => {
  try {
    const fonts = await Promise.all(
      ["NotoSans-Regular.ttf", "NotoSans-Bold.ttf"].map(async (name) => {
        const response = await fetch(
          new URL(`/fonts/${name}`, worker.location.origin),
        );
        if (!response.ok) throw new Error(`PDF_FONT_HTTP ${response.status}`);
        return new Uint8Array(await response.arrayBuffer());
      }),
    );
    const bytes = await renderLecturePdf(data.document, data.markdown, {
      regular: fonts[0],
      bold: fonts[1],
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
      message = `Il font PDF non contiene un simbolo (${native.split(" ").at(-1)}). Modifica quel simbolo negli appunti e riprova; il testo Markdown resta disponibile.`;
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
