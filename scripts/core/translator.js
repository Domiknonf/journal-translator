/**
 * Provider-agnostic translation engine: batching, prompting, validation and retries.
 *
 * An item is `{ id, html, context, check(output) => string|null }`. `check` validates a
 * translation (e.g. all placeholders present) and returns the final restored string, or
 * null if the output is unusable. Items that still fail after retries are reported as failed
 * and the caller keeps the original text.
 */

export const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    translations: { type: "array", items: { type: "string" } }
  },
  required: ["translations"],
  additionalProperties: false
};

export function buildSystemPrompt({ sourceLanguage, targetLanguage, glossary, instructions }) {
  const lines = [
    `You are a professional translator of tabletop role-playing game books (Dungeons & Dragons 5th edition, Forgotten Realms).`,
    `Translate from ${sourceLanguage} into ${targetLanguage}.`,
    ``,
    `Input: a JSON object {"context": string, "segments": string[]}. Every segment is an HTML fragment from a Foundry VTT journal page; "context" names the chapter/page it comes from.`,
    `Output: a JSON object {"translations": string[]} with exactly one translation per segment, in the same order.`,
    ``,
    `Rules:`,
    `- Keep the HTML structure. Every element carrying data-k="N" must appear exactly once in your translation with the same data-k value. Do not add attributes. You may move inline tags (<strong>, <em>, <a>, ...) when the grammar of the target language requires it.`,
    `- <x-e n="N">...</x-e> marks a link or rules reference. Keep every x-e element exactly once with the same n value and translate the text inside it.`,
    `- Markers like ⟦3⟧ stand for dice rolls, checks or links. Copy every marker exactly once, unchanged, to the grammatically fitting place in the sentence.`,
    `- Translate every segment completely and faithfully. Do not summarise, omit, explain or add content.`,
    `- Use the established official ${targetLanguage} terminology of Dungeons & Dragons for rules terms (abilities, skills, conditions, spells, magic items, creature types).`,
    `- Keep proper names of people, places, deities and organisations unless the glossary says otherwise or an official translation is well established.`,
    `- Keep numbers, dice expressions (e.g. 2d6 + 3) and abbreviations of measurements consistent with the target language (e.g. feet stay in feet, written as "Fuß").`,
    `- Keep the tone: boxed read-aloud text addresses the players directly.`,
    `- Return only the JSON object.`
  ];
  const g = (glossary ?? "").trim();
  if (g) lines.push("", "Glossary (source = target), always use these translations:", g);
  const extra = (instructions ?? "").trim();
  if (extra) lines.push("", "Additional instructions:", extra);
  return lines.join("\n");
}

/** Extract the translations array from a model response that should be JSON. */
export function parseTranslations(text) {
  let s = String(text ?? "").trim();
  const fence = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence) s = fence[1];
  let data;
  try {
    data = JSON.parse(s);
  } catch {
    const a = s.indexOf("{");
    const b = s.lastIndexOf("}");
    if (a === -1 || b <= a) throw new Error("Response is not JSON");
    data = JSON.parse(s.slice(a, b + 1));
  }
  const arr = Array.isArray(data) ? data : data?.translations;
  if (!Array.isArray(arr)) throw new Error("Response has no translations array");
  return arr.map((x) => (typeof x === "string" ? x : String(x ?? "")));
}

/** Group items into batches by context, limited by total characters and item count. */
export function makeBatches(items, { maxChars = 6000, maxItems = 60 } = {}) {
  const batches = [];
  let cur = null;
  for (const item of items) {
    const len = item.html.length;
    if (!cur || cur.context !== item.context || cur.chars + len > maxChars || cur.items.length >= maxItems) {
      if (cur && cur.items.length) batches.push(cur);
      cur = { context: item.context, items: [], chars: 0 };
    }
    cur.items.push(item);
    cur.chars += len;
  }
  if (cur && cur.items.length) batches.push(cur);
  return batches;
}

export class AbortError extends Error {
  constructor() {
    super("Translation cancelled");
    this.name = "AbortError";
  }
}

/**
 * Run the translation.
 * @param {object} opts
 * @param {{complete(req: {system: string, user: string, schema: object, signal?: AbortSignal}): Promise<{text: string, usage?: {input: number, output: number}}>}} opts.provider
 * @param {Array} opts.items
 * @param {object} opts.prompt         options for buildSystemPrompt
 * @param {number} [opts.maxChars]
 * @param {number} [opts.concurrency]
 * @param {AbortSignal} [opts.signal]
 * @param {(item, result: string|null, error?: string) => (void|Promise<void>)} [opts.onItem]
 * @param {(p: {done: number, total: number, failed: number, usage: object}) => void} [opts.onProgress]
 */
export async function translateItems({
  provider, items, prompt, maxChars = 6000, concurrency = 3, signal, onItem, onProgress, logger = console
}) {
  const system = buildSystemPrompt(prompt);
  const total = items.length;
  const progress = { done: 0, total, failed: 0, usage: { input: 0, output: 0 } };
  const results = new Map();

  const settle = async (item, value, error) => {
    results.set(item.id, value);
    progress.done++;
    if (value === null) {
      progress.failed++;
      const reason = item.lastError ? `${error} – ${item.lastError}` : error;
      logger.warn?.(`[journal-translator] Kept original for ${item.id}: ${reason}`, {
        sent: item.html,
        received: item.lastOutput
      });
      progress.reasons ??= {};
      const key = item.lastError?.replace(/\(.*\)/, "").trim() ?? error;
      progress.reasons[key] = (progress.reasons[key] ?? 0) + 1;
    }
    await onItem?.(item, value, error);
    onProgress?.({ ...progress, usage: { ...progress.usage } });
  };

  const callModel = async (context, batchItems, attempt) => {
    if (signal?.aborted) throw new AbortError();
    let user = batchPayload(context, batchItems);
    if (attempt > 0) {
      user = `Previous attempt broke the markup. Be very careful to keep every data-k element, every x-e element and every ⟦N⟧ marker exactly once.\n${user}`;
    }
    const res = await provider.complete({ system, user, schema: RESPONSE_SCHEMA, signal });
    if (res.usage) {
      progress.usage.input += res.usage.input ?? 0;
      progress.usage.output += res.usage.output ?? 0;
    }
    return parseTranslations(res.text);
  };

  const runBatch = async (context, batchItems, attempt = 0) => {
    let outputs;
    try {
      outputs = await callModel(context, batchItems, attempt);
    } catch (err) {
      if (err instanceof AbortError || signal?.aborted) throw new AbortError();
      if (err.fatal) throw err;
      outputs = null;
      if (batchItems.length === 1 && attempt >= 1) {
        return settle(batchItems[0], null, err.message);
      }
      logger.warn?.(`[journal-translator] Batch failed (${err.message}), retrying smaller`);
    }

    if (!outputs || outputs.length !== batchItems.length) {
      if (batchItems.length > 1) {
        const mid = Math.ceil(batchItems.length / 2);
        await runBatch(context, batchItems.slice(0, mid), attempt);
        await runBatch(context, batchItems.slice(mid), attempt);
        return;
      }
      if (attempt < 1) return runBatch(context, batchItems, attempt + 1);
      return settle(batchItems[0], null, "model returned no usable translation");
    }

    const retry = [];
    for (let i = 0; i < batchItems.length; i++) {
      const item = batchItems[i];
      const restored = item.check(outputs[i]);
      if (restored !== null && restored !== undefined) await settle(item, restored);
      else retry.push(item);
    }
    for (const item of retry) {
      if (attempt < 2) await runBatch(context, [item], attempt + 1);
      else await settle(item, null, "markup or links could not be preserved");
    }
  };

  const batches = makeBatches(items, { maxChars });
  let next = 0;
  const worker = async () => {
    while (next < batches.length) {
      if (signal?.aborted) throw new AbortError();
      const b = batches[next++];
      await runBatch(b.context, b.items);
    }
  };
  onProgress?.({ ...progress });
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, batches.length)) }, worker));
  return { results, ...progress };
}

/** The user message sent for one batch. */
export function batchPayload(context, items) {
  return JSON.stringify({ context, segments: items.map((i) => i.html) });
}

/** Typical growth of the output relative to the input when translating English into German. */
export const OUTPUT_RATIO = { low: 1.2, mid: 1.4, high: 1.6 };

/**
 * Count the tokens of the requests that a translation run would send, without generating.
 * Input tokens are counted with the provider's tokenizer (exact up to a few tokens of
 * per-request overhead); output tokens are estimated from the input with OUTPUT_RATIO.
 * @param {object} provider  provider with countTokens({ system, chunks })
 */
export async function countRequests(items, { provider, maxChars = 6000, prompt, signal }) {
  const batches = makeBatches(items, { maxChars });
  const system = buildSystemPrompt(prompt ?? {});
  const payloads = batches.map((b) => batchPayload(b.context, b.items));
  // Combine payloads into large chunks so that only a few counting calls are needed.
  const chunks = [];
  let cur = "";
  for (const p of payloads) {
    if (cur && cur.length + p.length > 400000) {
      chunks.push(cur);
      cur = "";
    }
    cur += (cur ? "\n" : "") + p;
  }
  if (cur) chunks.push(cur);

  const counted = await provider.countTokens({ system, chunks, signal });
  const requests = batches.length;
  const payloadTokens = counted.chunks;
  const inputTokens = requests * (counted.system + counted.perRequest) + payloadTokens;
  const output = {
    low: Math.round(payloadTokens * OUTPUT_RATIO.low),
    mid: Math.round(payloadTokens * OUTPUT_RATIO.mid),
    high: Math.round(payloadTokens * OUTPUT_RATIO.high)
  };
  return {
    segments: items.length, requests, systemTokens: counted.system, payloadTokens,
    inputTokens, outputTokens: output, method: counted.method
  };
}

/** Price in USD for the given token counts and prices per million tokens. */
export function priceOf(input, output, price) {
  if (!price) return null;
  return (input * price.input + output * price.output) / 1e6;
}

/** Rough token estimate without calling any API. */
export function estimate(items, { maxChars = 6000, prompt } = {}) {
  const batches = makeBatches(items, { maxChars });
  const chars = items.reduce((s, i) => s + i.html.length + (i.context?.length ?? 0) / 10, 0);
  const systemTokens = Math.ceil(buildSystemPrompt(prompt ?? {}).length / 4);
  const inputTokens = Math.ceil(chars / 3.2) + batches.length * (systemTokens + 30);
  const outputTokens = Math.ceil((chars / 3.2) * 1.3);
  return { segments: items.length, requests: batches.length, inputTokens, outputTokens };
}
