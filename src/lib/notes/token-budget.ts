import { Tiktoken } from "js-tiktoken/lite";
import o200kBase from "js-tiktoken/ranks/o200k_base";

let encoding: Tiktoken | undefined;
export function countTextTokens(text: string) {
  encoding ??= new Tiktoken(o200kBase);
  // Treat special-token-looking text as untrusted ordinary text, not controls.
  return encoding.encode(text, [], []).length;
}
/** GPT-OSS uses the o200k_base mergeable ranks in o200k_harmony. Count each
 * content/schema separately, then reserve 20% + 512 for framing/provider
 * differences and the entire completion budget, including reasoning. */
export function reserveTextTokens(
  messages: { content: string }[],
  format: unknown,
  maxOutput: number,
) {
  const inputTokens =
    messages.reduce(
      (total, message) => total + countTextTokens(message.content),
      0,
    ) + countTextTokens(JSON.stringify(format));
  return {
    inputTokens,
    tokenUpperBound: Math.ceil(inputTokens * 1.2) + 512 + maxOutput,
  };
}
