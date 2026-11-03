// List prices of the candidate models on Vultr Serverless Inference, pinned from the public catalogue
// (GET https://api.vultrinference.com/v1/models) on 4 Nov 2026, in USD per million tokens.
// inference.mjs uses them only when the live catalogue cannot be read or does not list a model, so a
// catalogue outage never makes a call look free. A model in neither list has no price: its cost shows
// as "n/a" and the spend guard refuses it or limits it by tokens (app/spend.mjs).
// Reasoning tokens are billed as completion tokens.

/** The day these prices were copied from the catalogue (shown on receipts as the price source). */
export const PINNED_AT = '2026-11-04';

/** Model id -> list price in USD per 1M tokens: prompt (input) and completion (output, reasoning included). */
export const PINNED_PRICES = Object.freeze({
  'deepseek-v4.1-flash-1017': Object.freeze({ promptPer1M: 0.15, completionPer1M: 0.6 }),
  'minimax-m3.1-flash': Object.freeze({ promptPer1M: 0.2, completionPer1M: 0.9 }),
  'glm-5.3': Object.freeze({ promptPer1M: 0.75, completionPer1M: 3 }),
  'glm-5.3-flash': Object.freeze({ promptPer1M: 0.1, completionPer1M: 0.35 }),
  'qwen3.8-27b': Object.freeze({ promptPer1M: 0.15, completionPer1M: 1 }),
  'qwen3.8-flash-next': Object.freeze({ promptPer1M: 0.1, completionPer1M: 0.2 }),
  'mimo-v2.6-flash': Object.freeze({ promptPer1M: 0.1, completionPer1M: 0.25 }),
});
