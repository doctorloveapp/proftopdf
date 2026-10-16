import type { LectureDocument, InlineContent } from "@/lib/shared/types";
import { timestamp } from "@/lib/transcription/merge";
import { documentHeading } from "@/lib/pdf/naming";
const content = (parts: InlineContent[]) =>
  parts
    .map((p) => (p.bold ? `**${p.text}**` : p.italic ? `*${p.text}*` : p.text))
    .join("");
export function documentMarkdown(document: LectureDocument) {
  const lines = [
    `# ${documentHeading(document)}`,
    `# ${document.title}`,
    !document.complete
      ? "> Dispensa parziale: sono presenti segmenti non trascritti."
      : "",
    "## Sommario",
    ...document.sections
      .filter((s) => s.level === 1)
      .map((s, i) => `${i + 1}. ${s.title}`),
  ];
  for (const section of document.sections) {
    lines.push(
      `${"#".repeat(Math.min(3, section.level + 1))} ${section.title}`,
    );
    for (const block of section.blocks) {
      if (block.type === "list")
        lines.push(
          block.items
            .map(
              (item, i) =>
                `${block.ordered ? `${i + 1}.` : "-"} ${content(item)}`,
            )
            .join("\n"),
        );
      else if (block.type === "uncertainty")
        lines.push(`> Da verificare: ${block.text}`);
      else
        lines.push(
          block.type === "key-concept"
            ? `**Concetto chiave:** ${content(block.content)}`
            : content(block.content),
        );
    }
  }
  if (document.glossary.length) {
    lines.push("## Glossario");
    for (const term of document.glossary)
      lines.push(`**${term.term}:** ${term.definition}`);
  }
  if (document.gaps.length) {
    lines.push("## Passaggi da verificare");
    lines.push(
      ...document.gaps.map(
        (gap) =>
          `- ${timestamp(gap.startSeconds)} - ${timestamp(gap.endSeconds)}: ${gap.reason}`,
      ),
    );
  }
  return lines.filter(Boolean).join("\n\n") + "\n";
}
export interface MarkdownBlock {
  kind: "heading" | "paragraph" | "bullet" | "quote";
  text: string;
  level?: number;
  marker?: string;
}
// Deliberately small, plain-text PDF subset: no arbitrary HTML/remote resources.
export function markdownBlocks(markdown: string): MarkdownBlock[] {
  const result: MarkdownBlock[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length)
      result.push({ kind: "paragraph", text: paragraph.join(" ") });
    paragraph = [];
  };
  for (const line of markdown.replace(/\r/g, "").split("\n")) {
    const heading = line.match(/^(#{1,3})\s+(.+)$/),
      bullet = line.match(/^\s*(?:[-*]|\d+[.)])\s+(.+)$/);
    if (!line.trim()) {
      flush();
      continue;
    }
    if (heading) {
      flush();
      result.push({
        kind: "heading",
        level: heading[1].length,
        text: heading[2],
      });
    } else if (bullet) {
      flush();
      result.push({
        kind: "bullet",
        text: bullet[1],
        marker: line.match(/^\s*(\d+[.)])\s+/)?.[1] ?? "•",
      });
    } else if (line.startsWith(">")) {
      flush();
      result.push({ kind: "quote", text: line.replace(/^>\s?/, "") });
    } else paragraph.push(line);
  }
  flush();
  return result;
}
