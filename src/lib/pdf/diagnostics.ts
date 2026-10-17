export type PdfFontEvent = "pdf.font.loading" | "pdf.font.fallback";
export type PdfMathEvent = "pdf.math.loading" | "pdf.math.complete";
export interface PdfLayoutDetails {
  pages: number;
  headingsMoved: number;
}
export interface PdfMathDetails {
  expressions: number;
  uniqueExpressions?: number;
  vectorPaths?: number;
}
export interface PdfFontDetails {
  font: "NotoSansMath";
  glyphs?: number;
  codePoints?: string;
}
export type PdfDiagnostic = (
  event: PdfFontEvent | PdfMathEvent | "pdf.layout.complete",
  details: PdfFontDetails | PdfMathDetails | PdfLayoutDetails,
) => void;
