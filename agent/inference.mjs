// Vultr Serverless Inference client (OpenAI-compatible chat completions with tool calling).
// Runs only in the orchestrator, outside every sandbox: the API key comes from the service's
// environment (systemd reads /etc/mantis-ring/secrets.env) and is never passed to a container.
// Each call has a token cap and a wall-clock timeout; usage and cost are added to a running tally.

export const INFERENCE_URL = process.env.VULTR_INFERENCE_URL || 'https://api.vultrinference.com/v1';

let pricing = null; // model id -> { prompt, completion } in USD per token, from the public catalog

/** Per-token prices from the public model catalog, fetched once. Unknown models cost 0 in the tally. */
export async function loadPricing() {
  if (pricing) return pricing;
  pricing = {};
  try {
    const res = await fetch(`${INFERENCE_URL}/models`, { signal: AbortSignal.timeout(15_000) });
    const { data = [] } = await res.json();
    for (const m of data) {
      const all = [...(m.input_modalities ?? []), ...(m.output_modalities ?? [])].flatMap((x) => x.pricing ?? []);
      const price = (type) => Number(all.find((p) => p.type === type && p.unit === 'token')?.cost_usd ?? 0);
      pricing[m.id] = { prompt: price('prompt'), completion: price('completion') };
    }
  } catch {
    // The catalog is only for the cost line on the receipt; a failure must not stop a task.
  }
  return pricing;
}

/** A running total of calls, tokens, cost and time, shared by everything one task does. */
export function newTally() {
  return { calls: 0, promptTokens: 0, completionTokens: 0, usd: 0, ms: 0, byModel: {} };
}

function addUsage(tally, model, usage, ms) {
  const p = pricing?.[model] ?? { prompt: 0, completion: 0 };
  const promptTokens = usage?.prompt_tokens ?? 0;
  const completionTokens = usage?.completion_tokens ?? 0;
  const usd = promptTokens * p.prompt + completionTokens * p.completion;
  for (const t of [tally, (tally.byModel[model] ??= { calls: 0, promptTokens: 0, completionTokens: 0, usd: 0, ms: 0 })]) {
    t.calls += 1;
    t.promptTokens += promptTokens;
    t.completionTokens += completionTokens;
    t.usd += usd;
    t.ms += ms;
  }
}

export class InferenceError extends Error {
  constructor(message, { status, retryable } = {}) {
    super(message);
    this.status = status;
    this.retryable = retryable;
  }
}

/**
 * One chat completion. Retries twice on rate limits, server errors and timeouts, with backoff.
 * Returns the assistant message ({ role, content, tool_calls? }) and the finish reason.
 */
export async function chat({ model, messages, tools, maxTokens = 4096, temperature = 0.2, timeoutMs = 120_000, tally }) {
  const key = process.env.VULTR_INFERENCE_API_KEY;
  if (!key) throw new InferenceError('VULTR_INFERENCE_API_KEY is not set for the orchestrator', { retryable: false });
  await loadPricing();
  const body = { model, messages, max_tokens: maxTokens, temperature, ...(tools?.length ? { tools, tool_choice: 'auto' } : {}) };
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await new Promise((ok) => setTimeout(ok, 2000 * 2 ** (attempt - 1)));
    const started = Date.now();
    try {
      const res = await fetch(`${INFERENCE_URL}/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await res.text();
      if (!res.ok) {
        // Never echo request headers; the response body is the provider's own error message.
        const retryable = res.status === 429 || res.status >= 500;
        lastError = new InferenceError(`inference ${res.status}: ${text.slice(0, 300)}`, { status: res.status, retryable });
        if (retryable) continue;
        throw lastError;
      }
      const json = JSON.parse(text);
      if (tally) addUsage(tally, model, json.usage, Date.now() - started);
      const choice = json.choices?.[0];
      if (!choice?.message) throw new InferenceError(`inference returned no message: ${text.slice(0, 200)}`, { retryable: true });
      return { message: choice.message, finishReason: choice.finish_reason, usage: json.usage };
    } catch (err) {
      if (err instanceof InferenceError && !err.retryable) throw err;
      lastError = err.name === 'TimeoutError' ? new InferenceError(`inference timed out after ${timeoutMs / 1000}s`, { retryable: true }) : err;
    }
  }
  throw lastError;
}

/** Cheap reachability check for /status: lists models with the key, no tokens spent. */
export async function ping() {
  const key = process.env.VULTR_INFERENCE_API_KEY;
  if (!key) return { ok: false, error: 'no key' };
  const started = Date.now();
  try {
    const res = await fetch(`${INFERENCE_URL}/models`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10_000) });
    return { ok: res.ok, status: res.status, ms: Date.now() - started };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
