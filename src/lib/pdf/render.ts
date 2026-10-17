import { PDFDocument, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import type { LectureDocument } from "@/lib/shared/types";
import { documentMarkdown, markdownBlocks } from "@/lib/notes/markdown";
import { inline } from "@/lib/notes/assemble";
import { documentHeading } from "./naming";
import type { PdfDiagnostic } from "./diagnostics";
import { MathRegistry } from "./math-spans";
import type { MathGraphic } from "./math-engine";
const WIDTH = 595.28,
  HEIGHT = 841.89,
  MARGIN = 48,
  TOP = 777,
  BOTTOM = 62;
interface TextRun {
  text: string;
  font: PDFFont;
  width: number;
}
type Run = TextRun | { math: MathGraphic; width: number; scale: number };
interface Line {
  runs: Run[];
  width: number;
  availableWidth: number;
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
  const registry = new MathRegistry();
  const heading = registry.protect(documentHeading(document));
  const protectedTitle = registry.protect(document.title);
  const protectedSubject = registry.protect(document.subject);
  const markup = registry.protect(markdown ?? documentMarkdown(document));
  let mathEngine: typeof import("./math-engine") | undefined;
  const graphics: MathGraphic[] = [];
  if (registry.expressions.length) {
    fonts.onDiagnostic?.("pdf.math.loading", {
      expressions: registry.occurrences,
    });
    mathEngine = await import("./math-engine");
    for (const [index, expression] of registry.expressions.entries()) {
      try {
        graphics.push(mathEngine.compileMath(expression));
      } catch {
        throw new Error(`PDF_MATH_INVALID: expression_${index + 1}`);
      }
    }
    fonts.onDiagnostic?.("pdf.math.complete", {
      expressions: registry.occurrences,
      uniqueExpressions: graphics.length,
      vectorPaths: graphics.reduce((n, value) => n + value.shapes.length, 0),
    });
  }
  // Preserve mathematical alphabets as distinct Unicode symbols. NFKC would
  // collapse script/double-struck letters and superscripts into other notation.
  const missing = new Set(
    Array.from(
      clean(
        registry.plain(
          `${heading} ${protectedTitle} ${protectedSubject} ${markup}`,
        ),
      ),
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
  function fontRuns(text: string, preferred: PDFFont, size: number): TextRun[] {
    const output: TextRun[] = [];
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
    let line: Line = { runs: [], width: 0, availableWidth: width };
    const flush = () => {
      while (
        line.runs.length &&
        "text" in line.runs.at(-1)! &&
        (line.runs.at(-1) as TextRun).text === " "
      ) {
        line.width -= line.runs.pop()!.width;
      }
      if (line.runs.length) lines.push(line);
      line = { runs: [], width: 0, availableWidth: width };
    };
    for (const part of inline(clean(text))) {
      const font = allBold || part.bold ? bold : regular;
      for (const piece of registry.parts(part.text)) {
        if ("index" in piece) {
          const math = graphics[piece.index];
          const factor = Math.min(1, width / (math.width * size));
          if (factor < 0.55)
            throw new Error("PDF_MATH_LAYOUT: expression_too_wide");
          if ((math.ascent + math.descent) * size * factor > TOP - BOTTOM)
            throw new Error("PDF_MATH_LAYOUT: expression_too_tall");
          const measured = math.width * size * factor;
          if (line.width + measured > width) flush();
          line.runs.push({
            math,
            scale: (size * factor) / 1000,
            width: measured,
          });
          line.width += measured;
          continue;
        }
        for (const token of piece.text.match(/\S+|\s+/gu) ?? []) {
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
    }
    flush();
    return lines;
  }
  function metrics(line: Line, size: number) {
    const ascent = Math.max(
      size,
      ...line.runs.map((run) =>
        "math" in run ? run.math.ascent * run.scale * 1000 : size,
      ),
    );
    const descent = Math.max(
      size * 0.25,
      ...line.runs.map((run) =>
        "math" in run ? run.math.descent * run.scale * 1000 : size * 0.25,
      ),
    );
    return {
      ascent,
      descent,
      extra: Math.max(0, ascent - size),
      advance: Math.max(size * 1.45, descent + size * 1.15),
    };
  }
  function draw(
    lines: Line[],
    size: number,
    x: number,
    color = ink,
    marker?: string,
    quote = false,
  ) {
    let quoteTop: number | undefined,
      quoteBottom = 0;
    const finishQuote = () => {
      if (quote && quoteTop !== undefined)
        page.drawLine({
          start: { x: MARGIN + 1, y: quoteTop },
          end: { x: MARGIN + 1, y: quoteBottom },
          thickness: 2,
          color: rgb(0.73, 0.55, 0.24),
        });
      quoteTop = undefined;
    };
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index],
        measure = metrics(line, size);
      const extra = Math.max(0, measure.ascent - size);
      const advance = Math.max(size * 1.45, measure.descent + size * 1.15);
      let baseline = y - extra;
      const next = lines[index + 1];
      const nextBottom = next
        ? baseline -
          advance -
          Math.max(0, metrics(next, size).ascent - size) -
          metrics(next, size).descent
        : Infinity;
      if (
        baseline - measure.descent < BOTTOM ||
        ((index === 0 || lines.length - index === 2) && nextBottom < BOTTOM)
      ) {
        finishQuote();
        newPage();
        baseline = y - extra;
      }
      quoteTop ??= baseline + measure.ascent;
      quoteBottom = baseline - measure.descent;
      if (marker && index === 0)
        page.drawText(marker, {
          x: x - regular.widthOfTextAtSize(marker, size) - 6,
          y: baseline,
          size,
          font: regular,
          color,
        });
      let cursor =
        x +
        (line.runs.length === 1 &&
        "math" in line.runs[0] &&
        line.runs[0].math.display
          ? (line.availableWidth - line.width) / 2
          : 0);
      for (const run of line.runs) {
        if ("math" in run)
          mathEngine!.drawMath(
            page,
            run.math,
            cursor,
            baseline,
            run.scale,
            color,
            regular,
          );
        else {
          page.drawText(run.text, {
            x: cursor,
            y: baseline,
            size,
            font: run.font,
            color,
          });
        }
        cursor += run.width;
      }
      y = baseline - advance;
    }
    finishQuote();
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
      : protectedTitle;
  const identity = wrap(heading, 22, WIDTH - 2 * MARGIN, true);
  draw(identity, 22, MARGIN, teal);
  draw(wrap(title, 22, WIDTH - 2 * MARGIN, true), 22, MARGIN, teal);
  partialNotice();
  // Measure the real wrapped content, including mathematical ascent/descent.
  // Consecutive headings travel with the first body lines, not just each other.
  const layouts = blocks.map((block) => {
    const heading = block.kind === "heading";
    const size = heading
      ? block.level === 1
        ? 22
        : block.level === 2
          ? 14
          : 11.5
      : block.kind === "quote"
        ? 9.5
        : 10;
    const marker = block.kind === "bullet" ? (block.marker ?? "•") : undefined;
    const indent = marker
      ? Math.max(14, regular.widthOfTextAtSize(marker, size) + 6)
      : block.kind === "quote"
        ? 11
        : 0;
    return {
      size,
      marker,
      indent,
      lines: wrap(block.text, size, WIDTH - 2 * MARGIN - indent, heading),
      before: heading ? size * 0.75 + (block.level === 1 ? 10 : 6) : 0,
    };
  });
  function headingFits(index: number) {
    let cursor = y;
    for (let next = index; next < blocks.length; next++) {
      const layout = layouts[next];
      cursor -= layout.before;
      const isHeading = blocks[next].kind === "heading";
      // draw() keeps the final two paragraph lines together. With exactly
      // three lines it needs all three, otherwise its widow rule could leave
      // just one line under a heading that passed a two-line preflight.
      const count = isHeading
        ? layout.lines.length
        : Math.min(layout.lines.length, layout.lines.length === 3 ? 3 : 2);
      for (const line of layout.lines.slice(0, count)) {
        const m = metrics(line, layout.size);
        if (cursor - m.extra - m.descent < BOTTOM) return false;
        cursor -= m.extra + m.advance;
      }
      if (!isHeading)
        return cursor - Math.max(0, 2 - count) * layout.size * 1.45 >= BOTTOM;
      cursor -= 8;
    }
    return cursor >= BOTTOM + 2 * 10 * 1.45;
  }
  let headingsMoved = 0;
  for (const [index, block] of blocks.entries()) {
    if (
      !document.complete &&
      block.text === "Dispensa parziale: sono presenti segmenti non trascritti."
    )
      continue;
    if (block.kind === "heading") {
      if (!headingFits(index) && y < TOP) {
        newPage();
        headingsMoved++;
      }
      const layout = layouts[index];
      y -= layout.before;
      draw(layout.lines, layout.size, MARGIN, block.level === 3 ? ink : teal);
    } else {
      const { lines, size, marker, indent } = layouts[index];
      draw(
        lines,
        size,
        MARGIN + indent,
        block.kind === "quote" ? amber : ink,
        marker,
        block.kind === "quote",
      );
    }
  }
  const pages = pdf.getPages();
  const header = wrap(
    `ProfToPdf | ${protectedSubject || "Dispensa universitaria"}`,
    8,
    WIDTH - 2 * MARGIN,
  )[0];
  if (!header)
    throw new Error("PDF_FONT_METRICS: invalid running header width");
  for (const [index, target] of pages.entries()) {
    // The first visible line on page one is subject + creation date.
    if (index > 0) {
      let cursor = MARGIN;
      for (const run of header.runs) {
        if ("math" in run)
          mathEngine!.drawMath(
            target,
            run.math,
            cursor,
            HEIGHT - 32,
            run.scale,
            muted,
            regular,
          );
        else {
          target.drawText(run.text, {
            x: cursor,
            y: HEIGHT - 32,
            size: 8,
            font: run.font,
            color: muted,
          });
        }
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
  fonts.onDiagnostic?.("pdf.layout.complete", {
    pages: pages.length,
    headingsMoved,
  });
  return pdf.save();
}
