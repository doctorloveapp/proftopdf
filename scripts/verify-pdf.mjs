import { mkdir, writeFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
async function main() {
  const sections = [];
  for (let n = 0; n < 10; n++) {
    sections.push({
      id: `c${n}`,
      title: `Capitolo ${n + 1}: energia, metodo e conoscenza`,
      level: 1,
      sourceSegmentIds: [`s${n}`],
      blocks: [],
    });
    sections.push({
      id: `s${n}`,
      title: "Principi, esempi e definizioni",
      level: 2,
      sourceSegmentIds: [`s${n}`],
      blocks: [
        {
          type: "paragraph",
          content: [
            {
              text: "L’energia è una grandezza fisica: qualità, quantità e possibilità di trasformazione. Le variabili α, β, γ e ω descrivono angoli e velocità. La relazione E = mc² lega massa ed energia. English stays English; cogito ergo sum; ἄνθρωπος e λόγος. ".repeat(
                8,
              ),
            },
          ],
          sourceSegmentIds: [`s${n}`],
        },
        {
          type: "key-concept",
          content: [
            { text: "Il ragionamento richiede " },
            { text: "fonti verificabili", bold: true },
            { text: " e passaggi espliciti." },
          ],
          sourceSegmentIds: [`s${n}`],
        },
        {
          type: "list",
          ordered: false,
          items: Array.from({ length: 12 }, (_, i) => [
            {
              text: `Punto ${i + 1}. Conservare definizioni, esempi e nessi logici; distinguere ciò che è noto da ciò che richiede verifica.`,
            },
          ]),
          sourceSegmentIds: [`s${n}`],
        },
        {
          type: "uncertainty",
          text: "Termine poco chiaro: consultare la registrazione prima di utilizzarlo nello studio.",
          sourceSegmentIds: [`s${n}`],
        },
      ],
    });
  }
  const now = "2026-10-16T22:30:00.000Z";
  const document = {
    version: 1,
    jobId: crypto.randomUUID(),
    title: "Energia e metodo scientifico",
    subject: "Collaudo sintetico - accenti, greco, elenchi e paginazione",
    language: "it",
    createdAt: now,
    updatedAt: now,
    sections,
    glossary: [
      {
        term: "Energia",
        definition: "Grandezza che descrive la capacità di compiere lavoro.",
        sourceSegmentIds: ["s0"],
      },
    ],
    gaps: [
      {
        startSeconds: 75,
        endSeconds: 83,
        reason: "Passaggio poco chiaro da verificare",
      },
    ],
    complete: false,
  };
  await mkdir("docs/pdf-qa", { recursive: true });
  // Exercise the actual browser bundle, using local font responses instead of
  // starting a browser/server or making any network request.
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url));
    const name = parsed.pathname.split("/").at(-1);
    if (
      parsed.origin !== "https://pdf-test.invalid" ||
      !["NotoSans-Regular.ttf", "NotoSans-Bold.ttf"].includes(name)
    )
      throw new Error("Unexpected network request in PDF test");
    return new Response(await readFile(resolve("public/fonts", name)));
  };
  let complete;
  const outcome = new Promise((resolve, reject) => {
    complete = { resolve, reject };
  });
  const timer = setTimeout(
    () => complete.reject(new Error("PDF worker test timeout")),
    120000,
  );
  globalThis.self = {
    location: { origin: "https://pdf-test.invalid" },
    postMessage: complete.resolve,
  };
  try {
    await import(pathToFileURL(resolve("public/pdf/pdf.worker.js")).href);
    await globalThis.self.onmessage({ data: { document } });
    const result = await outcome;
    if (!result.ok)
      throw new Error(
        `${result.message} ${result.nativeName}: ${result.technicalMessage}`,
      );
    await writeFile(
      "docs/pdf-qa/ProfToPdf-collaudo.pdf",
      new Uint8Array(result.buffer),
    );
    console.log(
      JSON.stringify({
        pdf: "docs/pdf-qa/ProfToPdf-collaudo.pdf",
        bytes: result.buffer.byteLength,
        synthetic: true,
        actualWorkerBundle: true,
      }),
    );
  } finally {
    clearTimeout(timer);
    globalThis.fetch = nativeFetch;
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
