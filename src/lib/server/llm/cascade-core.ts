import { RouteError } from "../http-core";
import type { LlmProvider, NotesUsage } from "@/lib/shared/types";
import type {
  NotesOutput,
  OutlineOutput,
  NotesRemote,
} from "@/lib/shared/processing";
export const LLM_ORDER: LlmProvider[] = ["openai", "openrouter", "groq"];
export interface CascadeState {
  index: number;
  round: number;
  roundHadInference: boolean;
  failures: { provider: LlmProvider; code: string; retryAt: string | null }[];
  usage: Omit<NotesUsage, "legs">[];
}
export const freshCascade = (): CascadeState => ({
  index: 0,
  round: 0,
  roundHadInference: false,
  failures: [],
  usage: [],
});
export interface CascadeDependencies {
  state: CascadeState;
  execute(
    provider: LlmProvider,
    round: number,
  ): Promise<NotesOutput | OutlineOutput>;
  save(state: CascadeState): Promise<void>;
  cache(result: NotesOutput | OutlineOutput): Promise<void>;
}
export function canFailover(error: RouteError) {
  return [
    "LLM_REJECTED",
    "LLM_QUOTA",
    "LLM_COOLDOWN",
    "LLM_NOT_CONFIGURED",
    "QUOTA_EXHAUSTED",
    "PROVIDER_COOLDOWN",
    "PROVIDER_RATE_LIMIT",
    "PROVIDER_AUTH",
    "PROVIDER_ACCESS_DENIED",
    "PROVIDER_MODEL_UNAVAILABLE",
  ].includes(error.code);
}
export function combinedUsage(legs: Omit<NotesUsage, "legs">[]): NotesUsage {
  return {
    reservedTokens: legs.reduce((n, leg) => n + leg.reservedTokens, 0),
    confirmedTokens: legs.every((leg) => leg.confirmedTokens !== null)
      ? legs.reduce((n, leg) => n + leg.confirmedTokens!, 0)
      : null,
    costMicroUsd: legs.every(
      (leg) => leg.costMicroUsd !== null && leg.costMicroUsd !== undefined,
    )
      ? legs.reduce((n, leg) => n + leg.costMicroUsd!, 0)
      : null,
    legs,
  };
}
/** At most one upstream inference per invocation. Rerouting persists before 202. */
export async function runCascade(
  deps: CascadeDependencies,
): Promise<NotesRemote> {
  const state = deps.state;
  while (state.index < LLM_ORDER.length) {
    const provider = LLM_ORDER[state.index];
    let started = false;
    try {
      const result = await deps.execute(provider, state.round);
      const legs = [...state.usage, ...(result.usage ? [result.usage] : [])];
      const output = { ...result, usage: combinedUsage(legs) };
      await deps.cache(output);
      return output;
    } catch (error) {
      if (!(error instanceof RouteError)) throw error;
      if (error.diagnostics?.usage) {
        const usage = {
          ...error.diagnostics.usage,
          provider,
          leg: state.round,
        };
        const prior = state.usage.findIndex(
          (value) => value.provider === provider && value.leg === state.round,
        );
        if (prior < 0) state.usage.push(usage);
        else state.usage[prior] = usage;
        state.roundHadInference = true;
        started = true;
      }
      if (error.code === "TOKEN_BUDGET" && provider === "groq") {
        await deps.save(state);
        return {
          state: "rebatch",
          provider: "groq",
          ...(state.usage.length ? { usage: combinedUsage(state.usage) } : {}),
        };
      }
      if (!canFailover(error)) {
        if (state.usage.length)
          error.diagnostics = {
            stage: "provider",
            issueCount: 0,
            issues: [],
            ...error.diagnostics,
            usage: combinedUsage(state.usage),
          };
        throw error;
      }
      state.failures.push({
        provider,
        code: error.code,
        retryAt: error.retryAt,
      });
      state.index++;
      await deps.save(state);
      // Any returned provider failure is definitive; ambiguous errors above stop.
      if (started && state.index < LLM_ORDER.length)
        return { state: "reroute", provider: LLM_ORDER[state.index] };
    }
  }
  const retry = state.failures
    .map((f) => f.retryAt)
    .filter((at): at is string => Boolean(at) && Date.parse(at!) > Date.now())
    .sort();
  if (retry.length && state.round < 2) {
    if (state.roundHadInference) state.round++;
    state.index = 0;
    state.roundHadInference = false;
    state.failures = [];
    await deps.save(state);
    throw new RouteError(
      429,
      "LLM_QUOTA",
      "Tutti i motori disponibili richiedono una pausa. Il lavoro è salvato.",
      retry[0],
      {
        stage: "quota",
        issueCount: 0,
        issues: [],
        ...(state.usage.length ? { usage: combinedUsage(state.usage) } : {}),
      },
    );
  }
  throw new RouteError(
    503,
    "LLM_UNAVAILABLE",
    "I tre motori degli appunti non sono disponibili. Il lavoro è salvato; verifica il log o riprova più tardi.",
    null,
    {
      stage: "provider",
      issueCount: 0,
      issues: [],
      ...(state.usage.length ? { usage: combinedUsage(state.usage) } : {}),
    },
  );
}
