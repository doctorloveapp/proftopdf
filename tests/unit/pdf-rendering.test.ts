import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  PDFDocument,
  PDFArray,
  PDFRawStream,
  decodePDFRawStream,
} from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { renderLecturePdf } from "../../src/lib/pdf/render";
import { createPdf } from "../../src/lib/pdf/client";
import { documentMarkdown } from "../../src/lib/notes/markdown";
import type { LectureDocument } from "../../src/lib/shared/types";

const bytes = Promise.all(
  ["NotoSans-Regular.ttf", "NotoSans-Bold.ttf", "NotoSansMath-Regular.ttf"].map(
    (name) => readFile(`public/fonts/${name}`),
  ),
);
function document(text: string): LectureDocument {
  return {
    version: 1,
    jobId: crypto.randomUUID(),
    title: "Formule e simboli",
    subject: "Fisica",
    language: "it",
    createdAt: "2026-10-17T12:00:00Z",
    updatedAt: "2026-10-17T12:00:00Z",
    complete: true,
    gaps: [],
    glossary: [],
    sections: [
      {
        id: "s0",
        title: "Dinamica",
        level: 1,
        sourceSegmentIds: ["s0"],
        blocks: [
          { type: "paragraph", content: [{ text }], sourceSegmentIds: ["s0"] },
        ],
      },
    ],
  };
}
test("Rendered headings move with body text, including three-line widows, consecutive headings and tall formulas", async () => {
  const [regular, bold] = await bytes;
  for (const variant of [
    "paragraph",
    "three-lines",
    "headings",
    "formula",
    "multiline",
  ]) {
    const doc = document("unused");
    const heading =
      variant === "multiline"
        ? "KeepHeading " + "argomento scientifico ".repeat(9)
        : "KeepHeading";
    const body =
      variant === "formula"
        ? String.raw`BodyStart \[\frac{\frac{a}{b}}{\frac{c}{d}}\] BodyEnd`
        : "BodyStart " +
          "contenuto ".repeat(variant === "three-lines" ? 24 : 15) +
          "BodyEnd";
    const markdown =
      `# ${doc.title}\n\n` +
      "Testo precedente.\n\n".repeat(25) +
      `## ${heading}\n\n` +
      (variant === "headings" ? "### NestedHeading\n\n" : "") +
      body;
    const result = await renderLecturePdf(doc, markdown, { regular, bold });
    const pdf = await PDFDocument.load(result);
    pdf.registerFontkit(fontkit);
    const textFont = await pdf.embedFont(regular, { subset: false });
    const headingFont = await pdf.embedFont(bold, { subset: false });
    const streams = pdf.getPages().map((page) => {
      const contents = page.node.Contents();
      const values =
        contents instanceof PDFArray
          ? contents.asArray()
          : contents
            ? [contents]
            : [];
      return values
        .map((value) => {
          const stream = pdf.context.lookup(value);
          assert(stream instanceof PDFRawStream);
          return Buffer.from(decodePDFRawStream(stream).decode()).toString(
            "latin1",
          );
        })
        .join("\n");
    });
    const locate = (word: string, isHeading = false) =>
      streams.findIndex((s) =>
        s.includes(
          (isHeading ? headingFont : textFont).encodeText(word).toString(),
        ),
      );
    assert.equal(pdf.getPageCount(), 2, variant);
    assert.equal(locate("KeepHeading", true), 1, variant);
    assert.equal(locate("BodyStart"), 1, variant);
    assert.equal(locate("BodyEnd"), 1, variant);
    if (variant === "headings") assert.equal(locate("NestedHeading", true), 1);
  }
});
test("Ordinary Italian/English/Greek and superscripts need no math font download", async () => {
  const [regular, bold] = await bytes;
  const result = await renderLecturePdf(
    document("Qualità. English. ἄνθρωπος. F = ma; E = mc², x₂."),
    undefined,
    {
      regular,
      bold,
      loadMath: async () => {
        throw new Error("Unnecessary font download");
      },
    },
  );
  assert.equal((await PDFDocument.load(result)).getPageCount(), 1);
});
test("Real math glyphs in bold titles, mixed text, long words and running headers render without rewriting the saved notes", async () => {
  const [regular, bold, math] = await bytes;
  const doc = document(
    "𝓏 ≠ z; 𝒂, 𝐅, 𝜔, 𝛼, ∂, ∑, ∫, x², x₂. " + "a𝓏".repeat(3000),
  );
  doc.subject = "Fisica 𝓏 ".repeat(20);
  doc.title += " 𝓏";
  doc.sections[0].title += " 𝓏";
  const original = structuredClone(doc),
    markdown = documentMarkdown(doc);
  const events: unknown[] = [];
  let loads = 0;
  const result = await renderLecturePdf(doc, markdown, {
    regular,
    bold,
    loadMath: async () => {
      loads++;
      return math;
    },
    onDiagnostic: (event, details) => {
      events.push({ event, ...details });
    },
  });
  assert((await PDFDocument.load(result)).getPageCount() >= 2);
  assert.equal(loads, 1);
  assert.deepEqual(doc, original);
  assert.equal(documentMarkdown(doc), markdown);
  assert(JSON.stringify(events).includes("U+1D4CF"));
  assert(!JSON.stringify(events).includes("Fisica"));
});
test("A character missing from every font still fails precisely instead of being silently removed", async () => {
  const [regular, bold, math] = await bytes;
  await assert.rejects(
    () =>
      renderLecturePdf(document("Passaggio \u{10FFFF}"), undefined, {
        regular,
        bold,
        math,
      }),
    /PDF_UNSUPPORTED_GLYPH U\+10FFFF/,
  );
});

test("Inline fractions and display integrals render locally with adaptive lines and preserve the saved Markdown", async () => {
  const [regular, bold] = await bytes;
  const doc = document(
    String.raw`La forza è \(\mathbf F_{ij}=-G\frac{m_i m_j}{r_{ij}^{2}}\mathbf u_{ij}\). Poi \[\int_0^t dt=t\] si ricava \(v=v_0+at\).`,
  );
  doc.title += String.raw` \(F=ma\)`;
  const markdown = documentMarkdown(doc),
    original = structuredClone(doc),
    events: unknown[] = [];
  const result = await renderLecturePdf(doc, markdown, {
    regular,
    bold,
    loadMath: async () => {
      throw new Error("Vector TeX must not download a fallback font");
    },
    onDiagnostic: (event, details) => events.push({ event, ...details }),
  });
  assert.equal((await PDFDocument.load(result)).getPageCount(), 1);
  assert(JSON.stringify(events).includes("pdf.math.complete"));
  assert.deepEqual(doc, original);
  assert.equal(documentMarkdown(doc), markdown);
});

test("An equation wider than the page is diagnosed instead of clipped or shrunk to unreadable text", async () => {
  const [regular, bold] = await bytes;
  await assert.rejects(
    () =>
      renderLecturePdf(document(`\\(${"x+".repeat(100)}1\\)`), undefined, {
        regular,
        bold,
      }),
    /PDF_MATH_LAYOUT: expression_too_wide/,
  );
});

test("A matrix taller than a page fails precisely instead of drawing outside the page", async () => {
  const [regular, bold] = await bytes;
  const tex =
    String.raw`\[\begin{matrix}` +
    Array(100).fill("1").join("\\\\") +
    String.raw`\end{matrix}\]`;
  await assert.rejects(
    () => renderLecturePdf(document(tex), undefined, { regular, bold }),
    /PDF_MATH_LAYOUT: expression_too_tall/,
  );
});
test("Math-font worker diagnostics do not terminate the worker or settle the PDF promise early", async (t) => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "Worker");
  let worker: FakeWorker;
  class FakeWorker {
    onmessage?: (event: { data: unknown }) => void;
    onerror?: () => void;
    terminated = 0;
    constructor() {
      worker = this;
    }
    postMessage() {}
    terminate() {
      this.terminated++;
    }
  }
  Object.defineProperty(globalThis, "Worker", {
    configurable: true,
    value: FakeWorker,
  });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, "Worker", previous);
    else Reflect.deleteProperty(globalThis, "Worker");
  });
  const events: unknown[] = [];
  const promise = createPdf(
    document("𝓏"),
    undefined,
    new AbortController().signal,
    (event, details) => events.push({ event, ...details }),
  );
  worker!.onmessage!({
    data: {
      type: "font-diagnostic",
      event: "pdf.font.loading",
      details: { font: "NotoSansMath" },
    },
  });
  worker!.onmessage!({
    data: {
      type: "font-diagnostic",
      event: "pdf.font.fallback",
      details: { font: "NotoSansMath", glyphs: 1, codePoints: "U+1D4CF" },
    },
  });
  assert.equal(worker!.terminated, 0);
  worker!.onmessage!({
    data: { ok: true, buffer: new Uint8Array([37, 80, 68, 70]).buffer },
  });
  assert.equal((await promise).size, 4);
  assert.equal(worker!.terminated, 1);
  assert.equal(events.length, 2);
});
