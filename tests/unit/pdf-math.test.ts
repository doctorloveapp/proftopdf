import { test } from "node:test";
import assert from "node:assert/strict";
import { splitMath, MathRegistry } from "../../src/lib/pdf/math-spans";
import { compileMath } from "../../src/lib/pdf/math-engine";
import { buildNotesRequest } from "../../src/lib/notes/prompt";
const gravity = String.raw`\mathbf F_{ij}=-G\frac{m_i m_j}{r_{ij}^{2}}\mathbf u_{ij}`;
test("TeX delimiters preserve nested arguments, indices, escapes and surrounding prose", () => {
  assert.deepEqual(splitMath(`Prima \\(${gravity}\\). Dopo.`), [
    { text: "Prima " },
    { math: { tex: gravity, display: false } },
    { text: ". Dopo." },
  ]);
  const display = splitMath(
    String.raw`Prima \[x=\frac{1}{2}at^2\] dopo $$v=v_0+at$$ e $x_0$.`,
  );
  assert.equal(display.filter((p) => "math" in p).length, 3);
  assert(display.some((p) => "math" in p && p.math.display));
});
test("Literal dollar amounts, escaped dollars and paths remain text", () => {
  for (const text of [
    "Costo $5 e $10, credito $0.02-$0.06.",
    String.raw`Percorso C:\lezioni\audio.mp3`,
  ])
    assert.deepEqual(splitMath(text), [{ text }]);
  assert.deepEqual(splitMath(String.raw`Costo \$5.`), [{ text: "Costo $5." }]);
});
test("Unclosed and oversized explicit math is a precise error, never silently dropped", () => {
  assert.throws(
    () => splitMath(String.raw`Prima \(x_0`),
    /PDF_MATH_INVALID: unclosed_delimiter/,
  );
  assert.throws(
    () => splitMath(`\\(${"x".repeat(4097)}\\)`),
    /PDF_MATH_INVALID: expression_size/,
  );
});
test("Math protection reuses repeated expressions, preserving Markdown and display blocks", () => {
  const registry = new MathRegistry();
  const protectedText = registry.protect(
    String.raw`**Prima \(x_0\)** e \(x_0\). \[\frac{1}{2}\]`,
  );
  assert.equal(registry.expressions.length, 2);
  assert.equal(registry.occurrences, 3);
  assert(protectedText.startsWith("**Prima "));
  assert(!protectedText.includes("x_0"));
  assert.equal(
    registry.parts(protectedText).filter((p) => "index" in p).length,
    3,
  );
  assert(!registry.plain(protectedText).includes("MJX"));
});
test("Gravity composes as vector paths and a fraction bar with exact source preserved for copying", () => {
  const formula = compileMath({ tex: gravity, display: false });
  assert(formula.width > 5);
  assert(formula.ascent > 0);
  assert(formula.descent > 0);
  assert(formula.shapes.some((shape) => shape.rect));
  assert(formula.shapes.some((shape) => shape.path));
  assert.equal(formula.copyText, gravity);
});
test("Integrals, units, text, matrices and nested fractions compose locally", () => {
  for (const tex of [
    String.raw`\int_0^t dt=t`,
    String.raw`2\ \mathrm{m/s}`,
    String.raw`a=\text{costante}`,
    String.raw`\frac{\frac{1}{2}at^2}{x_0+v_0t}`,
    String.raw`\begin{pmatrix}1&2\\3&4\end{pmatrix}`,
  ])
    assert(compileMath({ tex, display: true }).shapes.length > 0);
});
test("Unknown commands, custom macros and remote/HTML actions fail without leaking input", () => {
  for (const tex of [
    String.raw`\unknownsecret{private}`,
    String.raw`\href{https://private.invalid}{x}`,
    String.raw`\require{html}`,
    String.raw`\def\x{1}\x`,
    String.raw`\frac{1}{`,
  ])
    assert.throws(
      () => compileMath({ tex, display: false }),
      (error) =>
        error instanceof Error &&
        error.message.startsWith("PDF_MATH_INVALID:") &&
        !error.message.includes("private"),
    );
});
test("Every provider receives explicit compatible mathematical notation guidance", () => {
  const input = {
    jobId: crypto.randomUUID(),
    unitId: "math",
    mode: "notes" as const,
    attempt: 0,
    title: "Fisica",
    subject: "Scienze",
    sources: [{ id: "s0", text: "F=ma", uncertain: false }],
  };
  const prompt = buildNotesRequest(input).messages[0].content;
  assert(prompt.includes("\\(...\\)"));
  assert(prompt.includes("\\mathbf{F}"));
  assert(prompt.includes("senza Markdown interno"));
});
