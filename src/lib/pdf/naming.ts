import type { LectureDocument } from "@/lib/shared/types";

type Identity = Pick<LectureDocument, "subject" | "title" | "createdAt">;
export function creationDate(createdAt: string) {
  const date = new Date(createdAt);
  if (!Number.isFinite(date.getTime()))
    throw new Error("Data di creazione non valida.");
  return new Intl.DateTimeFormat("it-IT", {
    timeZone: "Europe/Rome",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(date);
}
export function documentHeading(document: Identity) {
  return [document.subject.trim(), creationDate(document.createdAt)]
    .filter(Boolean)
    .join(" - ");
}
export function documentFileStem(document: Identity) {
  const clean = (value: string) =>
    value
      .normalize("NFC")
      .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, "-")
      .replace(/\s+/g, " ")
      .replace(/[. ]+$/g, "")
      .trim();
  const label = [clean(document.subject), clean(document.title) || "Lezione"]
    .filter(Boolean)
    .join(" - ");
  // Slash is a path separator on mobile/desktop: use the same Italian order
  // with hyphens in filenames, while the PDF keeps dd/mm/yyyy.
  let safeLabel = "",
    bytes = 0;
  const encoder = new TextEncoder();
  for (const char of label) {
    const size = encoder.encode(char).byteLength;
    if (bytes + size > 220) break;
    safeLabel += char;
    bytes += size;
  }
  return `${safeLabel.trimEnd()} - ${creationDate(document.createdAt).replaceAll("/", "-")}`;
}
