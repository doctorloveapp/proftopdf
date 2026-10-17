import type { z } from "zod";
import type { ErrorDiagnostics } from "@/lib/shared/types";
import { RouteError } from "@/lib/server/http-core";

const fields = new Set([
  "sections",
  "title",
  "paragraphs",
  "bullets",
  "concepts",
  "sourceIds",
  "glossary",
  "term",
  "definition",
  "uncertainties",
  "text",
  "coveredSourceIds",
  "chapters",
  "sectionIds",
  "sourceNotes",
  "sourceId",
]);
export function schemaDiagnostics(
  issues: z.core.$ZodIssue[],
): ErrorDiagnostics {
  return {
    stage: "structure",
    issueCount: issues.length,
    issues: issues.slice(0, 6).map((issue) => ({
      path:
        issue.path
          .slice(0, 8)
          .map((part) =>
            typeof part === "number"
              ? String(part)
              : fields.has(String(part))
                ? String(part)
                : "field",
          )
          .join(".") || "$",
      code: issue.code,
      ...(issue.code === "invalid_type" &&
      ["array", "object", "string", "number", "boolean"].includes(
        issue.expected,
      )
        ? { expected: issue.expected }
        : {}),
    })),
  };
}
export function outputError(
  code: string,
  message: string,
  diagnostics: ErrorDiagnostics,
): never {
  throw new RouteError(502, code, message, null, diagnostics);
}
export function contentError(
  path: string,
  code = "NOTES_CONTENT",
  reason = "empty_content",
): never {
  outputError(
    code,
    `Gli appunti contengono un campo ${reason === "title_too_long" ? "troppo lungo" : "vuoto o incompleto"} (${path}). La trascrizione è conservata.`,
    {
      stage: "content",
      issueCount: 1,
      issues: [{ path, code: reason }],
    },
  );
}
