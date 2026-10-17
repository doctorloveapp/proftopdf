import { mkdir, writeFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
async function main() {
  const headingCheck = process.argv.includes("--headings");
  let markdown;
  const formulaFile = process.argv
    .find((arg) => arg.startsWith("--formulas-file="))
    ?.split("=")[1];
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
      title: "Principi, esempi e definizioni: 𝓏",
      level: 2,
      sourceSegmentIds: [`s${n}`],
      blocks: [
        ...(n === 0
          ? [
              {
                type: "paragraph",
                content: [
                  {
                    text: "Simboli conservati: 𝓏, 𝓐, 𝒂, 𝐅, 𝜔, 𝛼, ∂, ∑, ∫, ⟨v⟩, ℝ, ℂ, x² e x₂. ",
                  },
                  { text: "Grassetto misto: F = m𝛼; 𝓏 ≠ z.", bold: true },
                  { text: " Parola lunga: " + "a𝓏".repeat(85) },
                ],
                sourceSegmentIds: [`s${n}`],
              },
            ]
          : []),
        ...(n === 0
          ? [
              {
                type: "paragraph",
                content: [
                  {
                    text: String.raw`Formula inline: \(\mathbf F_{ij}=-G\frac{m_i m_j}{r_{ij}^{2}}\mathbf u_{ij}\). La frazione deve restare leggibile. Formula isolata:

\[x(t)=x_0+v_0t+\frac{1}{2}at^2\]

Matrice isolata: \[\begin{pmatrix}1&2\\3&4\end{pmatrix}\]`,
                  },
                ],
                sourceSegmentIds: [`s${n}`],
              },
            ]
          : []),
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
    subject: "Collaudo PDF 𝓏 - accenti, greco e matematica",
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
  if (formulaFile) {
    const audit = JSON.parse(await readFile(formulaFile, "utf8"));
    document.title = "Collaudo formule della lezione di fisica";
    document.subject = "Fisica";
    document.complete = true;
    document.gaps = [];
    document.sections = [
      {
        id: "formulas",
        title: "Gravitazione, dinamica e cinematica",
        level: 1,
        sourceSegmentIds: ["s0"],
        blocks: audit.formulas.map((formula, index) => ({
          type: "paragraph",
          content: [
            {
              text: `Formula ${index + 1}: \\(${formula.tex}\\). Testo prima e dopo la formula.`,
            },
          ],
          sourceSegmentIds: ["s0"],
        })),
      },
    ];
  }
  if (headingCheck) {
    document.title = "Collaudo titoli e cambio pagina";
    document.subject = "Fisica";
    document.complete = true;
    document.sections = [];
    document.gaps = [];
    markdown =
      `# ${document.title}\n\n` +
      "Testo della sezione precedente.\n\n".repeat(25) +
      "## Unità di misura, moto e accelerazione\n\n" +
      "La posizione si misura in metri, il tempo in secondi e la massa in chilogrammi. ".repeat(
        4,
      ) +
      "\n\n### Velocità e accelerazione\n\n" +
      String.raw`La relazione \(v=v_0+at\) collega velocità e accelerazione. L'accelerazione è la variazione della velocità nell'unità di tempo.`;
  }
  await mkdir("docs/pdf-qa", { recursive: true });
  // Exercise the actual browser bundle, using local font responses instead of
  // starting a browser/server or making any network request.
  const nativeFetch = globalThis.fetch;
  const fontRequests = [],
    diagnostics = [];
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url));
    const name = parsed.pathname.split("/").at(-1);
    if (
      parsed.origin !== "https://pdf-test.invalid" ||
      ![
        "NotoSans-Regular.ttf",
        "NotoSans-Bold.ttf",
        "NotoSansMath-Regular.ttf",
      ].includes(name)
    )
      throw new Error("Unexpected network request in PDF test");
    fontRequests.push(name);
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
    postMessage: (data) => {
      if (data.type === "font-diagnostic")
        diagnostics.push({ event: data.event, ...data.details });
      else complete.resolve(data);
    },
  };
  try {
    await import(pathToFileURL(resolve("public/pdf/pdf.worker.js")).href);
    await globalThis.self.onmessage({ data: { document, markdown } });
    const result = await outcome;
    if (!result.ok)
      throw new Error(
        `${result.message} ${result.nativeName}: ${result.technicalMessage}`,
      );
    if (!formulaFile && !headingCheck) {
      assert.equal(
        fontRequests.filter((name) => name === "NotoSansMath-Regular.ttf")
          .length,
        1,
      );
      assert(
        diagnostics.some(
          (d) =>
            d.event === "pdf.font.fallback" && d.codePoints.includes("U+1D4CF"),
        ),
      );
    } else if (formulaFile)
      assert(
        diagnostics.some(
          (d) => d.event === "pdf.math.complete" && d.uniqueExpressions > 20,
        ),
      );
    const outputPath = headingCheck
      ? "docs/pdf-qa/ProfToPdf-titoli.pdf"
      : formulaFile
        ? "docs/pdf-qa/ProfToPdf-formule.pdf"
        : "docs/pdf-qa/ProfToPdf-collaudo.pdf";
    await writeFile(outputPath, new Uint8Array(result.buffer));
    console.log(
      JSON.stringify({
        pdf: outputPath,
        bytes: result.buffer.byteLength,
        synthetic: true,
        actualWorkerBundle: true,
        fontRequests,
        diagnostics,
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
