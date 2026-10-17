import { mathjax } from "mathjax-full/js/mathjax.js";
import { TeX } from "mathjax-full/js/input/tex.js";
import { SVG } from "mathjax-full/js/output/svg.js";
import { liteAdaptor } from "mathjax-full/js/adaptors/liteAdaptor.js";
import { RegisterHTMLHandler } from "mathjax-full/js/handlers/html.js";
import "mathjax-full/js/input/tex/ams/AmsConfiguration.js";
import type { LiteElement } from "mathjax-full/js/adaptors/lite/Element.js";
import type { MathSpan } from "./math-spans";
import {
  concatTransformationMatrix,
  pushGraphicsState,
  popGraphicsState,
  PDFOperator,
  PDFOperatorNames,
  PDFName,
  PDFHexString,
  endMarkedContent,
  type PDFPage,
  type PDFFont,
  type Color,
} from "pdf-lib";
type Matrix = [number, number, number, number, number, number];
interface Shape {
  matrix: Matrix;
  path?: string;
  rect?: [number, number, number, number];
}
export interface MathGraphic {
  width: number;
  ascent: number;
  descent: number;
  display: boolean;
  shapes: Shape[];
  copyText: string;
}
const identity: Matrix = [1, 0, 0, 1, 0, 0];
function multiply(a: Matrix, b: Matrix): Matrix {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}
function transform(value = ""): Matrix {
  let matrix = identity;
  for (const match of value.matchAll(/(translate|scale|matrix)\(([^)]+)\)/g)) {
    const n = match[2]
      .trim()
      .split(/[\s,]+/)
      .map(Number);
    if (!n.every(Number.isFinite))
      throw new Error("PDF_MATH_INVALID: transform");
    const next: Matrix =
      match[1] === "translate"
        ? [1, 0, 0, 1, n[0], n[1] ?? 0]
        : match[1] === "scale"
          ? [n[0], 0, 0, n[1] ?? n[0], 0, 0]
          : (n as Matrix);
    if (next.length !== 6) throw new Error("PDF_MATH_INVALID: matrix");
    matrix = multiply(matrix, next);
  }
  if (value.replace(/(translate|scale|matrix)\([^)]+\)/g, "").trim())
    throw new Error("PDF_MATH_INVALID: unsupported_transform");
  return matrix;
}
const adaptor = liteAdaptor();
RegisterHTMLHandler(adaptor);
const engine = mathjax.document("", {
  InputJax: new TeX({
    packages: ["base", "ams"],
    maxMacros: 128,
    maxBuffer: 4096,
    formatError: () => {
      throw new Error("PDF_MATH_INVALID: tex_syntax");
    },
  }),
  OutputJax: new SVG({ fontCache: "none" }),
});
export function compileMath(span: MathSpan): MathGraphic {
  // No custom definitions, remote packages, HTML, URL actions or external SVG.
  if (
    span.tex.length > 4096 ||
    /\\(?:def|gdef|edef|xdef|let|newcommand|renewcommand|require|href|url|html\w*|include\w*|class|style)\b/.test(
      span.tex,
    )
  )
    throw new Error("PDF_MATH_INVALID: unsupported_command");
  try {
    const root = engine.convert(span.tex, {
      display: span.display,
    }) as LiteElement;
    const svg = adaptor.tags(root, "svg")[0];
    const box = String(adaptor.getAttribute(svg, "viewBox"))
      .trim()
      .split(/\s+/)
      .map(Number);
    if (
      box.length !== 4 ||
      !box.every(Number.isFinite) ||
      box[2] <= 0 ||
      box[3] <= 0
    )
      throw new Error("PDF_MATH_INVALID: bounds");
    const shapes: Shape[] = [];
    function visit(node: LiteElement, parent: Matrix) {
      const tag = adaptor.kind(node);
      if (["title", "desc", "defs"].includes(tag)) return;
      if (!["svg", "g", "path", "rect"].includes(tag))
        throw new Error("PDF_MATH_INVALID: unsupported_svg");
      const matrix = multiply(
        parent,
        transform(adaptor.getAttribute(node, "transform") ?? ""),
      );
      if (tag === "path") {
        shapes.push({ matrix, path: String(adaptor.getAttribute(node, "d")) });
      } else if (tag === "rect") {
        const rect = ["x", "y", "width", "height"].map((name) =>
          Number(adaptor.getAttribute(node, name) ?? 0),
        ) as [number, number, number, number];
        if (!rect.every(Number.isFinite))
          throw new Error("PDF_MATH_INVALID: rectangle");
        shapes.push({ matrix, rect });
      } else
        for (const child of adaptor.childNodes(node))
          visit(child as LiteElement, matrix);
      if (shapes.length > 2000) throw new Error("PDF_MATH_LIMIT: paths");
    }
    visit(svg, identity);
    if (!shapes.length) throw new Error("PDF_MATH_INVALID: empty");
    return {
      width: box[2] / 1000,
      ascent: -box[1] / 1000,
      descent: (box[1] + box[3]) / 1000,
      display: span.display,
      shapes,
      // Preserve the exact structured source for copying in compatible readers;
      // flattening glyph order would lose fraction and sub/superscript meaning.
      copyText: span.tex.trim(),
    };
  } catch (error) {
    if (
      error instanceof Error &&
      /^PDF_MATH_(INVALID|LIMIT): [a-z_]+$/.test(error.message)
    )
      throw error;
    throw new Error("PDF_MATH_INVALID: compilation");
  }
}
export function drawMath(
  page: PDFPage,
  graphic: MathGraphic,
  x: number,
  y: number,
  scale: number,
  color: Color,
  textFont: PDFFont,
) {
  // ActualText makes the vector expression selectable in compatible readers.
  page.pushOperators(
    PDFOperator.of(PDFOperatorNames.BeginMarkedContentSequence, [
      PDFName.of("Span"),
      page.doc.context
        .obj({
          ActualText: PDFHexString.fromText(graphic.copyText),
        })
        .toString(),
    ]),
  );
  // A transparent text anchor gives text extractors a span to associate with
  // ActualText; paths alone are ignored by readers such as Poppler.
  const size = scale * 1000;
  const spaces = Math.max(
    1,
    Math.ceil((graphic.width * size) / textFont.widthOfTextAtSize(" ", size)),
  );
  page.drawText(" ".repeat(spaces), { x, y, size, font: textFont, opacity: 0 });
  for (const shape of graphic.shapes) {
    const [a, b, c, d, e, f] = shape.matrix;
    page.pushOperators(
      pushGraphicsState(),
      concatTransformationMatrix(
        scale * a,
        -scale * b,
        scale * c,
        -scale * d,
        x + scale * e,
        y - scale * f,
      ),
    );
    if (shape.path) {
      // pdf-lib's SVG API already flips Y; cancel that inside the SVG CTM.
      page.pushOperators(concatTransformationMatrix(1, 0, 0, -1, 0, 0));
      page.drawSvgPath(shape.path, { x: 0, y: 0, scale: 1, color });
    } else if (shape.rect) {
      const [rx, ry, width, height] = shape.rect;
      page.drawRectangle({ x: rx, y: ry, width, height, color });
    }
    page.pushOperators(popGraphicsState());
  }
  page.pushOperators(endMarkedContent());
}
