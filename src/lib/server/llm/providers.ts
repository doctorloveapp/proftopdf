import "server-only";
import OpenAI from "openai";
import { getServerConfig } from "../config";
import { getGroq } from "../groq";
import { RouteError } from "../http-core";
import { acceptNotesCompletion } from "@/lib/notes/completion";
import { buildNotesRequest } from "@/lib/notes/prompt";
import {
  openAiNotesPayload,
  openRouterNotesPayload,
  lunaCostMicros,
} from "@/lib/notes/provider-payload";
import type {
  NotesRequest,
  NotesOutput,
  OutlineOutput,
} from "@/lib/shared/processing";
import type { LlmProvider } from "@/lib/shared/types";
import { confirmedFreeUsage } from "./usage-core";
export { mapProviderError } from "./provider-errors";
let openai: OpenAI | undefined;
export interface ProviderResult {
  data: NotesOutput | OutlineOutput;
  tokens: number;
  micros: number | null;
}
export function providerModel(provider: LlmProvider) {
  return provider === "openai"
    ? "gpt-6-luna"
    : provider === "openrouter"
      ? "dots-studio/dots-3-note-preview:free"
      : getServerConfig().GROQ_NOTES_MODEL;
}
export function providerConfigured(provider: LlmProvider) {
  const c = getServerConfig();
  return Boolean(
    provider === "openai"
      ? c.OPENAI_API_KEY
      : provider === "openrouter"
        ? c.OPENROUTER_API_KEY
        : c.GROQ_API_KEY,
  );
}
function accepted(
  input: NotesRequest,
  finish: string | undefined,
  content: string | null | undefined,
  tokens: number,
  micros: number | null,
): ProviderResult {
  try {
    return {
      data: acceptNotesCompletion(input, finish, content),
      tokens,
      micros,
    };
  } catch (error) {
    if (error instanceof RouteError) {
      error.confirmedUsage = tokens;
      error.diagnostics = {
        stage: "provider",
        issueCount: 0,
        issues: [],
        ...error.diagnostics,
        usage: {
          reservedTokens: tokens,
          confirmedTokens: tokens,
          costMicroUsd: micros,
        },
      };
    }
    throw error;
  }
}
export async function callProvider(
  provider: LlmProvider,
  input: NotesRequest,
): Promise<ProviderResult> {
  const c = getServerConfig();
  if (provider === "openai") {
    openai ??= new OpenAI({
      apiKey: c.OPENAI_API_KEY,
      baseURL: "https://api.openai.com/v1",
      timeout: 75000,
      maxRetries: 0,
    });
    const r = await openai.responses.create(openAiNotesPayload(input));
    const usage = r.usage;
    if (!usage)
      throw new RouteError(
        503,
        "RESULT_UNCERTAIN",
        "Consumo OpenAI non disponibile: recupera la stessa risposta prima di riprovare.",
      );
    return accepted(
      input,
      r.status === "completed" ? "stop" : "length",
      r.output_text,
      usage.total_tokens,
      lunaCostMicros(
        usage.input_tokens,
        usage.output_tokens,
        usage.input_tokens_details.cached_tokens,
      ),
    );
  }
  if (provider === "openrouter") {
    const response = await fetch(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        method: "POST",
        redirect: "error",
        headers: {
          Authorization: `Bearer ${c.OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(openRouterNotesPayload(input)),
        signal: AbortSignal.timeout(75000),
      },
    );
    if (!response.ok)
      throw { status: response.status, headers: response.headers };
    const r = await response.json();
    if (r.error)
      throw { status: Number(r.error?.code) || 503, headers: response.headers };
    const tokens = confirmedFreeUsage(r.usage);
    return accepted(
      input,
      r.choices?.[0]?.finish_reason,
      r.choices?.[0]?.message?.content,
      tokens,
      0,
    );
  }
  const payload = buildNotesRequest(input);
  const r = await getGroq().chat.completions.create(
    {
      model: c.GROQ_NOTES_MODEL,
      messages: payload.messages,
      response_format: payload.response_format,
      max_completion_tokens: payload.maxOutput,
      reasoning_effort: "low",
      temperature: 0.2,
    },
    { timeout: 75000, maxRetries: 0 },
  );
  return accepted(
    input,
    r.choices[0]?.finish_reason,
    r.choices[0]?.message?.content,
    r.usage?.total_tokens ?? payload.tokenUpperBound,
    0,
  );
}
