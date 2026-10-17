export type PdfFontEvent = "pdf.font.loading" | "pdf.font.fallback";
export interface PdfFontDetails {
  font: "NotoSansMath";
  glyphs?: number;
  codePoints?: string;
}
export type PdfDiagnostic = (
  event: PdfFontEvent,
  details: PdfFontDetails,
) => void;
