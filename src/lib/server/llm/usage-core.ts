import { RouteError } from "../http-core";

export function confirmedFreeUsage(
  usage: { total_tokens?: unknown; cost?: unknown } | null | undefined,
): number {
  if (
    !Number.isSafeInteger(usage?.total_tokens) ||
    Number(usage?.total_tokens) < 0 ||
    usage?.cost !== 0
  )
    throw new RouteError(
      503,
      "USAGE_UNVERIFIED",
      "Consumo gratuito OpenRouter non verificabile. Il lavoro è conservato.",
    );
  return usage!.total_tokens as number;
}
