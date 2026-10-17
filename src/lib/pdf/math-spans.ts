export interface MathSpan {
  tex: string;
  display: boolean;
}
export type MathPiece = { text: string } | { math: MathSpan };
export function splitMath(text: string): MathPiece[] {
  const pieces: MathPiece[] = [];
  let plain = "",
    index = 0;
  const flush = () => {
    if (plain) pieces.push({ text: plain });
    plain = "";
  };
  while (index < text.length) {
    if (text.startsWith("\\$", index)) {
      plain += "$";
      index += 2;
      continue;
    }
    const opener = text.startsWith("\\(", index)
      ? "\\("
      : text.startsWith("\\[", index)
        ? "\\["
        : text.startsWith("$$", index)
          ? "$$"
          : text[index] === "$"
            ? "$"
            : "";
    if (!opener) {
      plain += text[index++];
      continue;
    }
    const close = opener === "\\(" ? "\\)" : opener === "\\[" ? "\\]" : opener;
    let end = index + opener.length;
    while (
      end < text.length &&
      (!text.startsWith(close, end) || text[end - 1] === "\\")
    )
      end++;
    if (end === text.length) {
      if (opener !== "$")
        throw new Error("PDF_MATH_INVALID: unclosed_delimiter");
      plain += text[index++];
      continue;
    }
    const tex = text.slice(index + opener.length, end);
    // A price such as "$5 e $10" must remain prose, not become a formula.
    if (
      opener === "$" &&
      (!tex.trim() ||
        /^\s|\s$/.test(tex) ||
        /^\d/.test(text.slice(end + 1)) ||
        /^[\d.,]+$/.test(tex))
    ) {
      plain += text[index++];
      continue;
    }
    if (!tex.trim() || tex.length > 4096)
      throw new Error("PDF_MATH_INVALID: expression_size");
    flush();
    pieces.push({
      math: { tex, display: opener === "\\[" || opener === "$$" },
    });
    index = end + close.length;
  }
  flush();
  return pieces;
}

/** Protect TeX before Markdown parsing. Repeated expressions share one token. */
export class MathRegistry {
  readonly expressions: MathSpan[] = [];
  occurrences = 0;
  private readonly prefix = `\uE000MJX${crypto.randomUUID()}:`;
  private readonly suffix = "\uE001";
  private readonly ids = new Map<string, number>();
  private readonly matcher = new RegExp(
    `${this.prefix}(\\d+)${this.suffix}`,
    "g",
  );
  protect(text: string) {
    return splitMath(text)
      .map((piece) => {
        if ("text" in piece) return piece.text;
        if (++this.occurrences > 1000)
          throw new Error("PDF_MATH_LIMIT: expression_count");
        const key = JSON.stringify(piece.math);
        let id = this.ids.get(key);
        if (id === undefined) {
          id = this.expressions.length;
          this.ids.set(key, id);
          this.expressions.push(piece.math);
        }
        const token = `${this.prefix}${id}${this.suffix}`;
        return piece.math.display ? `\n\n${token}\n\n` : token;
      })
      .join("");
  }
  plain(text: string) {
    return text.replace(this.matcher, "");
  }
  parts(text: string): ({ text: string } | { index: number })[] {
    const pieces: ({ text: string } | { index: number })[] = [];
    let prior = 0;
    for (const match of text.matchAll(this.matcher)) {
      if (match.index! > prior)
        pieces.push({ text: text.slice(prior, match.index) });
      pieces.push({ index: Number(match[1]) });
      prior = match.index! + match[0].length;
    }
    if (prior < text.length) pieces.push({ text: text.slice(prior) });
    return pieces;
  }
}
