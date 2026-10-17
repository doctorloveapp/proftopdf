import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PDFDocument } from "pdf-lib";
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
