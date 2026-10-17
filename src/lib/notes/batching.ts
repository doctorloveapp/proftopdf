import { sha256 } from "@noble/hashes/sha2.js";
import { buildTextUnits, unitId, type TextUnit } from "./assemble";
import { buildNotesRequest } from "./prompt";
import {
  utf8Bytes,
  NOTES_BUDGET_REVISION,
  type NotesRequest,
  type ProcessingData,
  type SourceItem,
} from "@/lib/shared/processing";
import type { TranscriptSegment } from "@/lib/shared/types";

// Below the server's 6,000 token/minute ceiling, including the repair prompt
// and full completion budget. The server independently repeats this check.
export const NOTES_BATCH_RESERVATION = 5500;
type Context = Pick<
  NotesRequest,
  "jobId" | "title" | "subject" | "languagePolicy"
>;
const yieldToBrowser = () =>
  new Promise<void>((resolve) => setTimeout(resolve, 0));
function digest(sources: SourceItem[]) {
  return Array.from(
    sha256(new TextEncoder().encode(JSON.stringify(sources))),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}
export async function groupTextSources(
  sources: SourceItem[],
  context: Context,
  mode: "notes" | "outline",
  signal?: AbortSignal,
  startIndex = 0,
): Promise<TextUnit[]> {
  const units: TextUnit[] = [];
  let pending: SourceItem[] = [];
  const prefix = mode === "notes" ? "batch" : "batch-outline";
  const input = (items: SourceItem[]): NotesRequest => ({
    ...context,
    mode,
    attempt: 2,
    unitId: unitId(prefix, startIndex + units.length, items),
    sources: items,
  });
  const fits = (items: SourceItem[]) =>
    items.length <= 30 &&
    utf8Bytes(JSON.stringify(input(items))) <= 14_000 &&
    buildNotesRequest(input(items)).tokenUpperBound <= NOTES_BATCH_RESERVATION;
  const flush = () => {
    if (pending.length)
      units.push({
        id: unitId(prefix, startIndex + units.length, pending),
        sources: pending,
      });
    pending = [];
  };
  for (const [index, source] of sources.entries()) {
    if (index % 8 === 0) {
      await yieldToBrowser();
      signal?.throwIfAborted();
    }
    if (!fits([...pending, source])) {
      flush();
      if (!fits([source]))
        throw new Error(
          "Un frammento di testo supera il budget gratuito. Esporta il log diagnostico.",
        );
    }
    pending.push(source);
  }
  flush();
  signal?.throwIfAborted();
  return units;
}
export async function planNotes(
  segments: TranscriptSegment[],
  data: ProcessingData,
  context: Context,
  signal?: AbortSignal,
): Promise<NonNullable<ProcessingData["notesPlan"]>> {
  const legacy = buildTextUnits(segments),
    sources = legacy.flatMap((unit) => unit.sources),
    sourceDigest = digest(sources);
  if (
    data.notesPlan?.version === "bpe-v1" &&
    data.notesPlan.sourceDigest === sourceDigest
  ) {
    const plan = data.notesPlan;
    if (plan.budgetRevision === NOTES_BUDGET_REVISION) return plan;
    const units: TextUnit[] = [],
      splitDepths = { ...plan.splitDepths };
    let untouched: SourceItem[] = [];
    async function flushUntouched() {
      if (!untouched.length) return;
      units.push(
        ...(await groupTextSources(
          untouched,
          context,
          "notes",
          signal,
          units.length,
        )),
      );
      untouched = [];
    }
    for (const unit of plan.units) {
      signal?.throwIfAborted();
      // Keep confirmed units and the operation whose result may be ambiguous.
      // Pack untouched consecutive work together, avoiding a tiny extra request
      // for the tail of EVERY old batch after a prompt/schema budget change.
      if (
        data.notes[unit.id] ||
        (data.failedUnitId === `notes-${unit.id}` &&
          data.failedUnitId !== data.quotaBlockedUnitId)
      ) {
        await flushUntouched();
        units.push(unit);
      } else if (plan.splitDepths?.[unit.id]) {
        // Do not merge bounded repair children back into their oversized parent.
        await flushUntouched();
        const resized = await groupTextSources(
          unit.sources,
          context,
          "notes",
          signal,
          units.length,
        );
        if (plan.splitDepths?.[unit.id] !== undefined)
          for (const child of resized)
            splitDepths[child.id] = plan.splitDepths[unit.id];
        units.push(...resized);
      } else untouched.push(...unit.sources);
    }
    await flushUntouched();
    return {
      ...plan,
      units,
      ...(Object.keys(splitDepths).length ? { splitDepths } : {}),
      budgetRevision: NOTES_BUDGET_REVISION,
    };
  }
  // A deployment must not throw away confirmed old units or rename the failed
  // operation being repaired. Preserve that prefix, pack only untouched text.
  let preserved = 0;
  for (const [index, unit] of legacy.entries())
    if (data.notes[unit.id] || data.failedUnitId === `notes-${unit.id}`)
      preserved = index + 1;
  const prefix = legacy.slice(0, preserved);
  const remaining = legacy.slice(preserved).flatMap((unit) => unit.sources);
  const packed = await groupTextSources(
    remaining,
    context,
    "notes",
    signal,
    preserved,
  );
  return {
    version: "bpe-v1",
    budgetRevision: NOTES_BUDGET_REVISION,
    sourceDigest,
    units: [...prefix, ...packed],
  };
}

/** One bounded split after a definitive failure, not a retry-budget reset.
 * Children have independent, persisted operation IDs; cannot split again. */
export function splitFailedNotesUnit(
  plan: NonNullable<ProcessingData["notesPlan"]>,
  id: string,
) {
  const index = plan.units.findIndex((unit) => unit.id === id),
    unit = plan.units[index];
  const depth = plan.splitDepths?.[id] ?? 0;
  if (!unit || unit.sources.length < 2 || depth >= 1) return null;
  const middle = Math.ceil(unit.sources.length / 2);
  const children = [
    unit.sources.slice(0, middle),
    unit.sources.slice(middle),
  ].map((sources, part) => ({
    id: unitId("repair1", index + part, sources),
    sources,
  }));
  plan.splitDepths ??= {};
  for (const child of children) plan.splitDepths[child.id] = depth + 1;
  plan.units.splice(index, 1, ...children);
  return { parent: unit, children };
}
