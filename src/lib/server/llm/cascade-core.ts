import { RouteError } from "../http-core";
import type { LlmProvider, NotesUsage } from "@/lib/shared/types";
import type {
  NotesOutput,
  OutlineOutput,
  NotesRemote,
} from "@/lib/shared/processing";
import { LLM_POLICY_REVISION } from "@/lib/shared/processing";
export { LLM_POLICY_REVISION } from "@/lib/shared/processing";
export const LLM_ORDER: LlmProvider[] = ["openai", "groq", "openrouter"];
export const GROQ_MAX_WAIT_MS = 15 * 60 * 1000;
export interface CascadeState {
  policy?: string;
  groqLeg?: number;
  index: number;
  round: number;
  roundHadInference: boolean;
  failures: { provider: LlmProvider; code: string; retryAt: string | null }[];
  usage: Omit<NotesUsage, "legs">[];
}
export const freshCascade = (): CascadeState => ({
  policy: LLM_POLICY_REVISION,
  groqLeg: 0,
  index: 0,
  round: 0,
  roundHadInference: false,
  failures: [],
  usage: [],
});
export interface CascadeDependencies {
  now?: () => number;
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
    "PROVIDER_SERVICE_UNAVAILABLE",
  ].includes(error.code);
}
const groqWaitCodes = new Set([
  "LLM_QUOTA",
  "LLM_COOLDOWN",
  "QUOTA_EXHAUSTED",
  "PROVIDER_COOLDOWN",
  "PROVIDER_RATE_LIMIT",
]);
/** Strict threshold: exactly fifteen minutes still stays with Groq. */
export function shouldWaitOnGroq(error: RouteError, now = Date.now()) {
  return (
    groqWaitCodes.has(error.code) &&
    (!error.retryAt ||
      !Number.isFinite(Date.parse(error.retryAt)) ||
      Date.parse(error.retryAt) - now <= GROQ_MAX_WAIT_MS)
  );
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
  const now = deps.now ?? Date.now;
  if (state.policy !== LLM_POLICY_REVISION) {
    // Keep operation/cache IDs stable across deployment. Old index 1 was
    // OpenRouter: reassess Groq first, without replaying a paid OpenAI leg.
    state.index = state.index === 0 ? 0 : 1;
    state.groqLeg = state.round;
    state.policy = LLM_POLICY_REVISION;
    await deps.save(state);
  }
  while (state.index < LLM_ORDER.length) {
    const provider = LLM_ORDER[state.index];
    const leg = provider === "groq" ? (state.groqLeg ?? 0) : state.round;
    let started = false;
    try {
      const result = await deps.execute(provider, leg);
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
          leg,
        };
        const prior = state.usage.findIndex(
          (value) => value.provider === provider && value.leg === leg,
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
      // A received 429 has its own cached rejection. The next safe Groq
      // attempt needs a new leg; a local quota denial consumes no leg.
      if (provider === "groq" && started) state.groqLeg = leg + 1;
      if (provider === "groq" && shouldWaitOnGroq(error, now())) {
        await deps.save(state); // pin Groq across polling, pause and resume
        throw new RouteError(
          429,
          "LLM_QUOTA",
          "Groq richiede una breve pausa. Il lavoro è salvato e riprenderà sullo stesso motore.",
          error.retryAt && Date.parse(error.retryAt) > now()
            ? error.retryAt
            : new Date(now() + 60_000).toISOString(),
          {
            stage: "quota",
            issueCount: 0,
            issues: [],
            ...error.diagnostics,
            ...(state.usage.length
              ? { usage: combinedUsage(state.usage) }
              : {}),
          },
        );
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
