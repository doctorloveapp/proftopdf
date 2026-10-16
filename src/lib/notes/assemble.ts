import type {
  LectureDocument,
  LectureSection,
  DocumentBlock,
  InlineContent,
  TranscriptSegment,
} from "@/lib/shared/types";
import {
  NOTES_SOURCE_BYTES,
  utf8Bytes,
  type SourceItem,
  type NotesOutput,
  type OutlineOutput,
} from "@/lib/shared/processing";
import { sha256 } from "@noble/hashes/sha2.js";
export interface TextUnit {
  id: string;
  sources: SourceItem[];
}
const originalSources=(ids:string[])=>[...new Set(ids.map((id)=>id.replace(/p\d+$/,"")))];
function unitId(prefix: string, index: number, sources: SourceItem[]) {
  const hash = sha256(new TextEncoder().encode(JSON.stringify(sources)));
  return `${prefix}-${index}-${Array.from(hash.subarray(0, 8), (b) => b.toString(16).padStart(2, "0")).join("")}`;
}
function splitText(text: string, maxBytes: number) {
  const parts: string[] = [];
  let current = "";
  for (const token of text.match(/\S+\s*/gu) ?? []) {
    if (utf8Bytes(token) > maxBytes) {
      if (current.trim()) {
        parts.push(current.trim());
        current = "";
      }
      for (const character of token) {
        if (utf8Bytes(current + character) > maxBytes) {
          parts.push(current.trim());
          current = "";
        }
        current += character;
      }
    } else {
      if (utf8Bytes(current + token) > maxBytes && current.trim()) {
        parts.push(current.trim());
        current = "";
      }
      current += token;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}
export function buildTextUnits(
  segments: TranscriptSegment[],
  budget = NOTES_SOURCE_BYTES,
): TextUnit[] {
  const units: TextUnit[] = [];
  let sources: SourceItem[] = [],
    bytes = 0;
  const flush = () => {
    if (sources.length)
      units.push({ id: unitId("unit", units.length, sources), sources });
    sources = [];
    bytes = 0;
  };
  for (const segment of segments) {
    if (
      segment.status === "missing" ||
      segment.text === "[Nessun parlato rilevato in questo segmento]"
    )
      continue;
    for (const [part, text] of splitText(
      segment.text,
      Math.min(600, budget),
    ).entries()) {
      const source = {
        id: `${segment.id}p${part}`,
        text,
        uncertain: segment.status === "uncertain",
      };
      const cost = utf8Bytes(JSON.stringify(source)) + 1;
      if (sources.length && bytes + cost > budget) flush();
      sources.push(source);
      bytes += cost;
    }
  }
  flush();
  return units;
}
export function inline(text: string): InlineContent[] {
  return text
    .split(/(\*\*[^*]+\*\*)/g)
    .filter(Boolean)
    .map((part) =>
      part.startsWith("**") && part.endsWith("**")
        ? { text: part.slice(2, -2), bold: true }
        : { text: part },
    );
}
export function materializeSections(
  units: TextUnit[],
  outputs: Record<string, NotesOutput>,
): LectureSection[] {
  return units.flatMap((unit) =>
    (outputs[unit.id]?.sections ?? []).map((section, i) => {
      const sourceIds=originalSources(section.sourceIds);
      const blocks: DocumentBlock[] = [
        ...section.paragraphs.map((text) => ({
          type: "paragraph" as const,
          content: inline(text),
          sourceSegmentIds: sourceIds,
        })),
        ...section.concepts.map((text) => ({
          type: "key-concept" as const,
          content: inline(text),
          sourceSegmentIds: sourceIds,
        })),
      ];
      if (section.bullets.length)
        blocks.push({
          type: "list",
          ordered: false,
          items: section.bullets.map(inline),
          sourceSegmentIds: sourceIds,
        });
      for (const uncertain of outputs[unit.id].uncertainties.filter((u) =>
        u.sourceIds.some((id) => section.sourceIds.includes(id)),
      ))
        blocks.push({
          type: "uncertainty",
          text: uncertain.text,
          sourceSegmentIds: originalSources(uncertain.sourceIds),
        });
      return {
        id: `${unit.id}-s${i}`,
        title: section.title,
        level: 2 as const,
        blocks,
        sourceSegmentIds: sourceIds,
      };
    }),
  );
}
export function buildOutlineUnits(sections: LectureSection[]): TextUnit[] {
  const units: TextUnit[] = [];
  let sources: SourceItem[] = [],
    bytes = 0;
  for (const section of sections) {
    const item = { id: section.id, text: section.title, uncertain: false },
      cost = utf8Bytes(JSON.stringify(item));
    if (
      sources.length &&
      (bytes + cost > NOTES_SOURCE_BYTES || sources.length >= 12)
    ) {
      units.push({ id: unitId("outline", units.length, sources), sources });
      sources = [];
      bytes = 0;
    }
    sources.push(item);
    bytes += cost;
  }
  if (sources.length)
    units.push({ id: unitId("outline", units.length, sources), sources });
  return units;
}
export function assembleDocument(options: {
  jobId: string;
  title: string;
  subject: string;
  segments: TranscriptSegment[];
  units: TextUnit[];
  notes: Record<string, NotesOutput>;
  outlines: Record<string, OutlineOutput>;
}): LectureDocument {
  const sections = materializeSections(options.units, options.notes),
    outlineUnits = buildOutlineUnits(sections),
    byId = new Map(sections.map((s) => [s.id, s]));
  const final: LectureSection[] = [];
  for (const unit of outlineUnits) {
    const outline = options.outlines[unit.id];
    if (!outline) throw new Error("Indice incompleto.");
    for (const chapter of outline.chapters) {
      const children = chapter.sectionIds.map((id) => byId.get(id));
      if (children.some((s) => !s)) throw new Error("Indice incoerente.");
      final.push(
        {
          id: `chapter-${final.filter((s) => s.level === 1).length}`,
          title: chapter.title,
          level: 1,
          blocks: [],
          sourceSegmentIds: [...new Set(children.flatMap((s) => s!.sourceSegmentIds))],
        },
        ...(children as LectureSection[]),
      );
    }
  }
  const glossary = new Map<string, LectureDocument["glossary"][number]>();
  for (const unit of options.units)
    for (const term of options.notes[unit.id].glossary) {
      const key = term.term.trim().toLocaleLowerCase("it"),
        prior = glossary.get(key);
      if (prior)
        prior.sourceSegmentIds = [
          ...new Set([...prior.sourceSegmentIds, ...originalSources(term.sourceIds)]),
        ];
      else
        glossary.set(key, {
          term: term.term,
          definition: term.definition,
          sourceSegmentIds: originalSources(term.sourceIds),
        });
    }
  const gaps = options.segments
    .filter((s) => s.status !== "confirmed")
    .map((s) => ({
      startSeconds: s.startSeconds,
      endSeconds: s.endSeconds,
      reason:
        s.status === "missing"
          ? "Segmento non trascritto"
          : "Passaggio da verificare nella registrazione originale",
    }));
  const now = new Date().toISOString();
  return {
    version: 1,
    jobId: options.jobId,
    title: options.title,
    subject: options.subject,
    language: "it",
    createdAt: now,
    updatedAt: now,
    sections: final,
    glossary: [...glossary.values()],
    gaps,
    complete: !options.segments.some((s) => s.status === "missing"),
  };
}
