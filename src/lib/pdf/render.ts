import { PDFDocument, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import type { LectureDocument } from "@/lib/shared/types";
import { documentMarkdown, markdownBlocks } from "@/lib/notes/markdown";
import { inline } from "@/lib/notes/assemble";
import { documentHeading } from "./naming";
import type { PdfDiagnostic } from "./diagnostics";
const WIDTH = 595.28,
  HEIGHT = 841.89,
  MARGIN = 48,
  TOP = 777,
  BOTTOM = 62;
interface Run {
  text: string;
  font: PDFFont;
  width: number;
}
interface Line {
  runs: Run[];
  width: number;
}
function clean(text: string) {
  return text
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ");
}
export async function renderLecturePdf(
  document: LectureDocument,
  markdown: string | undefined,
  fonts: {
    regular: Uint8Array;
    bold: Uint8Array;
    math?: Uint8Array;
    loadMath?: () => Promise<Uint8Array>;
    onDiagnostic?: PdfDiagnostic;
  },
) {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  pdf.setTitle(document.title);
  pdf.setAuthor("ProfToPdf");
  pdf.setSubject(document.subject);
  pdf.setLanguage("it");
  const [regular, bold] = await Promise.all([
    pdf.embedFont(fonts.regular, { subset: false }),
    pdf.embedFont(fonts.bold, { subset: false }),
  ]);
  const regularChars = new Set(regular.getCharacterSet()),
    boldChars = new Set(bold.getCharacterSet());
  const heading = documentHeading(document);
  const markup = markdown ?? documentMarkdown(document);
  // Preserve mathematical alphabets as distinct Unicode symbols. NFKC would
  // collapse script/double-struck letters and superscripts into other notation.
  const missing = new Set(
    Array.from(
      clean(`${heading} ${document.title} ${document.subject} ${markup}`),
    )
      .map((char) => char.codePointAt(0)!)
      .filter((code) => !regularChars.has(code) && !boldChars.has(code)),
  );
  let math: PDFFont | undefined;
  if (missing.size) {
    if (!fonts.math && fonts.loadMath)
      fonts.onDiagnostic?.("pdf.font.loading", { font: "NotoSansMath" });
    const bytes = fonts.math ?? (await fonts.loadMath?.());
    if (bytes) math = await pdf.embedFont(bytes, { subset: false });
  }
  const mathChars = new Set(math?.getCharacterSet() ?? []);
  const supported = [...missing].filter((code) => mathChars.has(code));
  if (supported.length)
    fonts.onDiagnostic?.("pdf.font.fallback", {
      font: "NotoSansMath",
      glyphs: supported.length,
      codePoints: supported
        .slice(0, 12)
        .map((code) => `U+${code.toString(16).toUpperCase()}`)
        .join(","),
    });
  function fontRuns(text: string, preferred: PDFFont, size: number): Run[] {
    const output: Run[] = [];
    let current: PDFFont | undefined,
      value = "";
    const flush = () => {
      if (current && value)
        output.push({
          text: value,
          font: current,
          width: current.widthOfTextAtSize(value, size),
        });
      value = "";
    };
    for (const char of text) {
      const code = char.codePointAt(0)!;
      const preferredChars = preferred === bold ? boldChars : regularChars;
      const chosen = preferredChars.has(code)
        ? preferred
        : regularChars.has(code)
          ? regular
          : boldChars.has(code)
            ? bold
            : math && mathChars.has(code)
              ? math
              : undefined;
      if (!chosen)
        throw new Error(
          `PDF_UNSUPPORTED_GLYPH U+${code.toString(16).toUpperCase()}`,
        );
      if (chosen !== current) {
        flush();
        current = chosen;
      }
      value += char;
    }
    flush();
    return output;
  }
  const ink = rgb(0.085, 0.18, 0.22),
    teal = rgb(0.025, 0.32, 0.43),
    muted = rgb(0.34, 0.46, 0.52),
    amber = rgb(0.45, 0.32, 0.14);
  let page: PDFPage,
    y = TOP;
  function shorten(text: string, font: PDFFont, size: number, width: number) {
    const characters = Array.from(clean(text));
    while (
      characters.length &&
      fontRuns(characters.join(""), font, size).reduce(
        (sum, run) => sum + run.width,
        0,
      ) > width
    )
      characters.pop();
    return characters.join("");
  }
  function newPage() {
    page = pdf.addPage([WIDTH, HEIGHT]);
    y = TOP;
    page.drawLine({
      start: { x: MARGIN, y: HEIGHT - 43 },
      end: { x: WIDTH - MARGIN, y: HEIGHT - 43 },
      thickness: 0.5,
      color: rgb(0.83, 0.88, 0.9),
    });
  }
  function wrap(
    text: string,
    size: number,
    width: number,
    allBold = false,
  ): Line[] {
    const lines: Line[] = [];
    let line: Line = { runs: [], width: 0 };
    const flush = () => {
      while (line.runs.at(-1)?.text === " ") {
        line.width -= line.runs.pop()!.width;
      }
      if (line.runs.length) lines.push(line);
      line = { runs: [], width: 0 };
    };
    for (const part of inline(clean(text))) {
      const font = allBold || part.bold ? bold : regular;
      for (const token of part.text.match(/\S+|\s+/gu) ?? []) {
        const word = /^\s+$/.test(token) ? " " : token;
        if (word === " " && !line.runs.length) continue;
        const runs = fontRuns(word, font, size);
        const measured = runs.reduce((sum, run) => sum + run.width, 0);
        if (measured > width) {
          for (const char of word) {
            const run = fontRuns(char, font, size)[0],
              advance = run.width;
            if (line.width + advance > width) flush();
            line.runs.push(run);
            line.width += advance;
          }
        } else {
          if (line.width + measured > width) flush();
          if (word === " " && !line.runs.length) continue;
          line.runs.push(...runs);
          line.width += measured;
        }
      }
    }
    flush();
    return lines;
  }
  function draw(
    lines: Line[],
    size: number,
    x: number,
    color = ink,
    marker?: string,
    quote = false,
  ) {
    const leading = size * 1.45;
    let index = 0;
    while (index < lines.length) {
      let available = Math.floor((y - BOTTOM) / leading) + 1;
      if (available < 1 || (available < 2 && lines.length - index > 1)) {
        newPage();
        continue;
      }
      if (
        lines.length - index > available &&
        lines.length - index - available === 1 &&
        available > 1
      )
        available--;
      const stop = Math.min(lines.length, index + available),
        firstY = y;
      for (; index < stop; index++) {
        if (marker && index === 0)
          page.drawText(marker, {
            x: x - regular.widthOfTextAtSize(marker, size) - 6,
            y,
            size,
            font: regular,
            color,
          });
        let cursor = x;
        for (const run of lines[index].runs) {
          page.drawText(run.text, {
            x: cursor,
            y,
            size,
            font: run.font,
            color,
          });
          cursor += run.width;
        }
        y -= leading;
      }
      if (quote)
        page.drawLine({
          start: { x: MARGIN + 1, y: firstY + size },
          end: { x: MARGIN + 1, y: y + leading - 3 },
          thickness: 2,
          color: rgb(0.73, 0.55, 0.24),
        });
      if (index < lines.length) newPage();
    }
    y -= 8;
  }
  newPage();
  function partialNotice() {
    if (document.complete) return;
    const lines = wrap(
      "DISPENSA PARZIALE - Alcuni segmenti non sono stati trascritti. Consultare i passaggi da verificare.",
      9,
      WIDTH - 2 * MARGIN - 20,
    );
    const height = lines.length * 9 * 1.45 + 20;
    page!.drawRectangle({
      x: MARGIN,
      y: y - height + 10,
      width: WIDTH - 2 * MARGIN,
      height,
      color: rgb(1, 0.96, 0.87),
    });
    draw(lines, 9, MARGIN + 10, amber);
    y -= 12;
  }
  const blocks = markdownBlocks(markup);
  // Canonical first line even for a saved draft from the previous renderer.
  if (blocks[0]?.kind === "heading" && blocks[0].text === heading)
    blocks.shift();
  if (
    blocks[1]?.kind === "paragraph" &&
    blocks[1].text === `Materia: ${document.subject}`
  )
    blocks.splice(1, 1);
  const title =
    blocks[0]?.kind === "heading" && blocks[0].level === 1
      ? blocks.shift()!.text
      : document.title;
  const identity = wrap(heading, 22, WIDTH - 2 * MARGIN, true);
  draw(identity, 22, MARGIN, teal);
  draw(wrap(title, 22, WIDTH - 2 * MARGIN, true), 22, MARGIN, teal);
  partialNotice();
  for (const block of blocks) {
    if (
      !document.complete &&
      block.text === "Dispensa parziale: sono presenti segmenti non trascritti."
    )
      continue;
    if (block.kind === "heading") {
      const size = block.level === 1 ? 22 : block.level === 2 ? 14 : 11.5;
      const lines = wrap(block.text, size, WIDTH - 2 * MARGIN, true),
        required = lines.length * size * 1.45 + 42;
      y -= size * 0.75 + (block.level === 1 ? 10 : 6);
      if (y - required < BOTTOM) newPage();
      draw(lines, size, MARGIN, block.level === 3 ? ink : teal);
    } else {
      const size = block.kind === "quote" ? 9.5 : 10;
      const marker =
        block.kind === "bullet" ? (block.marker ?? "•") : undefined;
      const indent = marker
        ? Math.max(14, regular.widthOfTextAtSize(marker, size) + 6)
        : block.kind === "quote"
          ? 11
          : 0;
      draw(
        wrap(block.text, size, WIDTH - 2 * MARGIN - indent),
        size,
        MARGIN + indent,
        block.kind === "quote" ? amber : ink,
        marker,
        block.kind === "quote",
      );
    }
  }
  const pages = pdf.getPages();
  const header = shorten(
    `ProfToPdf | ${document.subject || "Dispensa universitaria"}`,
    regular,
    8,
    WIDTH - 2 * MARGIN,
  );
  if (!header)
    throw new Error("PDF_FONT_METRICS: invalid running header width");
  for (const [index, target] of pages.entries()) {
    // The first visible line on page one is subject + creation date.
    if (index > 0) {
      let cursor = MARGIN;
      for (const run of fontRuns(header, regular, 8)) {
        target.drawText(run.text, {
          x: cursor,
          y: HEIGHT - 32,
          size: 8,
          font: run.font,
          color: muted,
        });
        cursor += run.width;
      }
    }
    const label = `${index + 1} / ${pages.length}`;
    target.drawText(label, {
      x: WIDTH - MARGIN - regular.widthOfTextAtSize(label, 8),
      y: 30,
      font: regular,
      size: 8,
      color: muted,
    });
  }
  return pdf.save();
}
