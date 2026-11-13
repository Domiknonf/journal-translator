/**
 * LLM providers. Every provider exposes
 *   complete({ system, user, schema, signal }) -> Promise<{ text, usage: { input, output } }>
 * All requests are made directly from the GM's browser with `fetch`, so only APIs that allow
 * browser (CORS) requests can be used. DeepL, for example, does not and is therefore not offered.
 */

export const PROVIDERS = {
  openai: {
    label: "OpenAI",
    defaultModel: "gpt-5-mini",
    keyUrl: "https://platform.openai.com/api-keys",
    create: (cfg) => openAICompatible({ ...cfg, baseUrl: "https://api.openai.com/v1", strictSchema: true })
  },
  anthropic: {
    label: "Anthropic (Claude)",
    defaultModel: "claude-opus-5-5",
    keyUrl: "https://platform.claude.com/settings/keys",
    create: (cfg) => anthropic(cfg)
  },
  gemini: {
    label: "Google Gemini",
    defaultModel: "gemini-2.5-flash",
    keyUrl: "https://aistudio.google.com/apikey",
    create: (cfg) => gemini(cfg)
  },
  compatible: {
    label: "OpenAI-compatible (OpenRouter, Mistral, Ollama, LM Studio, ...)",
    defaultModel: "",
    keyUrl: "",
    create: (cfg) => openAICompatible({ ...cfg, strictSchema: false })
  }
};

/**
 * List prices in USD per 1M tokens (input / output) for common models. Prices change, so
 * they can be overridden in the module settings. Unknown models show token counts only.
 */
export const PRICES = {
  "claude-fable-5-1": { input: 10, output: 50 },
  "claude-opus-5-5": { input: 4, output: 20 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5 },
  "gpt-5": { input: 1.25, output: 10 },
  "gpt-5-mini": { input: 0.25, output: 2 },
  "gpt-5-nano": { input: 0.05, output: 0.4 },
  "gpt-4.1": { input: 2, output: 8 },
  "gpt-4.1-mini": { input: 0.4, output: 1.6 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "gemini-2.5-pro": { input: 1.25, output: 10 },
  "gemini-2.5-flash": { input: 0.3, output: 2.5 },
  "gemini-2.5-flash-lite": { input: 0.1, output: 0.4 }
};

/** Local o200k tokenizer (OpenAI GPT-4o/GPT-5 family), loaded only when needed (~2.8 MB). */
let tokenizer = null;
export async function localCount(text) {
  tokenizer ??= await import("../vendor/o200k.js");
  return tokenizer.countTokens(text);
}

async function countLocally({ system, chunks }) {
  let total = 0;
  for (const c of chunks) total += await localCount(c);
  // Chat format adds a few tokens per message.
  return { system: (await localCount(system)) + 4, perRequest: 8, chunks: total, method: "tokenizer" };
}

export class ProviderError extends Error {
  constructor(message, { status, fatal = false } = {}) {
    super(message);
    this.name = "ProviderError";
    this.status = status;
    this.fatal = fatal;
  }
}

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new DOMException("Aborted", "AbortError"));
    }, { once: true });
  });

/** POST JSON with retries on rate limits, overload and network errors. */
export async function postJSON(url, { headers, body, signal, retries = 5, onRetry, fetchImpl = globalThis.fetch }) {
  let lastError;
  const host = new URL(url).host;
  const wait = async (ms, error) => {
    onRetry?.(`${error.message} – ${Math.round(ms / 1000)} s`);
    console.warn(`[journal-translator] ${error.message}; retrying in ${Math.round(ms / 1000)} s`);
    await sleep(ms, signal);
  };
  for (let attempt = 0; attempt <= retries; attempt++) {
    let res;
    try {
      res = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
        signal
      });
    } catch (err) {
      if (signal?.aborted) throw err;
      // Also what the browser reports when the server rejects the request without CORS
      // headers (e.g. an invalid key on some APIs). A few quick retries are enough.
      lastError = new ProviderError(`No connection to ${host} (${err.message})`);
      if (attempt >= 2) break;
      await wait(1000 * 2 ** attempt, lastError);
      continue;
    }
    if (res.ok) return res.json();

    let detail = "";
    try {
      const j = await res.json();
      detail = j?.error?.message ?? j?.message ?? JSON.stringify(j);
    } catch {
      detail = res.statusText;
    }
    const retryable = res.status === 408 || res.status === 409 || res.status === 429 || res.status >= 500;
    // 401/403: wrong key; 402 / "credit balance": billing; 404: unknown model.
    // Retrying cannot help, so stop the whole job with this message.
    const fatal = [401, 402, 403, 404].includes(res.status) || /credit|billing|quota|balance/i.test(detail);
    lastError = new ProviderError(`HTTP ${res.status} from ${host}: ${detail}`, { status: res.status, fatal });
    if (!retryable || fatal) throw lastError;
    const ra = Number(res.headers.get?.("retry-after"));
    await wait(Number.isFinite(ra) && ra > 0 ? ra * 1000 : Math.min(60000, 2000 * 2 ** attempt), lastError);
  }
  throw lastError;
}

function requireKey(apiKey, label) {
  if (!apiKey) throw new ProviderError(`No API key configured for ${label}.`, { fatal: true });
}

/** OpenAI Chat Completions, and any server that speaks the same protocol. */
export function openAICompatible({ apiKey, model, baseUrl, strictSchema, fetchImpl }) {
  // Reasoning models think before answering and bill those tokens as output. Translation
  // needs little reasoning, so keep it low. Only sent to OpenAI models that accept it.
  const reasoning = strictSchema && /^(gpt-5|o[1-9])/.test(model ?? "") ? "low" : null;
  if (!baseUrl) throw new ProviderError("No base URL configured for the OpenAI-compatible provider.", { fatal: true });
  if (strictSchema) requireKey(apiKey, "OpenAI");
  if (!model) throw new ProviderError("No model configured.", { fatal: true });
  const url = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
  return {
    async complete({ system, user, schema, signal, onRetry }) {
      const body = {
        model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user }
        ],
        response_format: strictSchema
          ? { type: "json_schema", json_schema: { name: "translations", strict: true, schema } }
          : { type: "json_object" }
      };
      if (reasoning) body.reasoning_effort = reasoning;
      const headers = apiKey ? { authorization: `Bearer ${apiKey}` } : {};
      const data = await postJSON(url, { headers, body, signal, onRetry, fetchImpl });
      const choice = data.choices?.[0];
      if (choice?.finish_reason === "length") throw new ProviderError("Response was cut off (output limit).");
      if (choice?.message?.refusal) throw new ProviderError(`Model refused: ${choice.message.refusal}`);
      return {
        text: choice?.message?.content ?? "",
        usage: { input: data.usage?.prompt_tokens ?? 0, output: data.usage?.completion_tokens ?? 0 }
      };
    },
    countTokens: countLocally
  };
}

/** Anthropic Messages API, called directly from the browser. */
export function anthropic({ apiKey, model, effort, fetchImpl }) {
  requireKey(apiKey, "Anthropic");
  // Server-side fallback on safety refusals, supported by these models on the Claude API.
  const supportsFallback = /^claude-(opus-5-5|fable-5-1|sonnet-5-5)$/.test(model);
  const baseHeaders = {
    "x-api-key": apiKey,
    "anthropic-version": "2026-10-21",
    "anthropic-dangerous-direct-browser-access": "true"
  };
  const count = async (body, signal) => {
    const data = await postJSON("https://api.anthropic.com/v1/messages/count_tokens", {
      headers: baseHeaders, body: { model, ...body }, signal, fetchImpl
    });
    return data.input_tokens ?? 0;
  };
  return {
    /** Exact counts from the free token counting endpoint. */
    async countTokens({ system, chunks, signal }) {
      const dot = [{ role: "user", content: "." }];
      const base = await count({ messages: dot }, signal);
      const withSystem = await count({ system, messages: dot }, signal);
      let total = 0;
      for (const c of chunks) total += (await count({ messages: [{ role: "user", content: c }] }, signal)) - base + 1;
      return { system: withSystem - base, perRequest: base, chunks: total, method: "api" };
    },
    async complete({ system, user, schema, signal, onRetry }) {
      const body = {
        model,
        max_tokens: 32000,
        system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: user }],
        output_config: {
          ...(effort ? { effort } : {}),
          format: { type: "json_schema", schema }
        }
      };
      const headers = { ...baseHeaders };
      if (supportsFallback) {
        body.fallbacks = "default";
        headers["anthropic-beta"] = "server-side-fallback-2026-07-01";
      }
      const data = await postJSON("https://api.anthropic.com/v1/messages", { headers, body, signal, onRetry, fetchImpl });
      if (data.stop_reason === "refusal") {
        throw new ProviderError(`Model declined the request${data.stop_details?.category ? ` (${data.stop_details.category})` : ""}.`);
      }
      if (data.stop_reason === "max_tokens") throw new ProviderError("Response was cut off (output limit).");
      const text = (data.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("");
      const u = data.usage ?? {};
      return {
        text,
        usage: {
          input: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
          output: u.output_tokens ?? 0
        }
      };
    }
  };
}

/** Google Gemini generateContent. */
export function gemini({ apiKey, model, fetchImpl }) {
  requireKey(apiKey, "Google Gemini");
  const base = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}`;
  const url = `${base}:generateContent`;
  // Flash models can switch thinking off entirely; thinking tokens are billed as output.
  const noThinking = /flash/.test(model);
  const count = async (text, signal) => {
    const data = await postJSON(`${base}:countTokens`, {
      headers: { "x-goog-api-key": apiKey },
      body: { contents: [{ role: "user", parts: [{ text }] }] },
      signal, fetchImpl
    });
    return data.totalTokens ?? 0;
  };
  return {
    /** Exact counts from the free countTokens endpoint. */
    async countTokens({ system, chunks, signal }) {
      let total = 0;
      for (const c of chunks) total += await count(c, signal);
      return { system: await count(system, signal), perRequest: 4, chunks: total, method: "api" };
    },
    async complete({ system, user, signal, onRetry }) {
      const body = {
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: user }] }],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: {
            type: "OBJECT",
            properties: { translations: { type: "ARRAY", items: { type: "STRING" } } },
            required: ["translations"]
          },
          ...(noThinking ? { thinkingConfig: { thinkingBudget: 0 } } : {})
        }
      };
      const data = await postJSON(url, { headers: { "x-goog-api-key": apiKey }, body, signal, onRetry, fetchImpl });
      const cand = data.candidates?.[0];
      if (!cand) throw new ProviderError(`No answer${data.promptFeedback?.blockReason ? ` (${data.promptFeedback.blockReason})` : ""}.`);
      if (cand.finishReason === "MAX_TOKENS") throw new ProviderError("Response was cut off (output limit).");
      const text = (cand.content?.parts ?? []).map((p) => p.text ?? "").join("");
      return {
        text,
        usage: { input: data.usageMetadata?.promptTokenCount ?? 0, output: data.usageMetadata?.candidatesTokenCount ?? 0 }
      };
    }
  };
}
